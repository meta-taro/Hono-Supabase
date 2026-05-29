import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ReviewListCursor } from '@/modules/reviews/domain/review.repository';
import { ShopReviewSupabaseRepository } from './shop-review.supabase-repository';
import { ShopReviewAlreadyExistsError } from '@/modules/reviews/domain/shop-review.errors';
import { ConflictError } from '@/shared/domain/errors';
import { loadEnv, type RawEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカル」に対して動く。`supabase start` が前提。
//
// 店舗レビューは単一店舗（shop_id なし）なので、対象の絞り込みは存在しない。
// list() / stats() は「テーブル全体の published」を見る。テスト分離は beforeEach の
// cleanup で毎回テストユーザーを掃除して担保する（seed.sql に shop_reviews は無い）。
//
// テスト分離戦略:
//   - auth ユーザー: メールアドレスに `@test-shop-reviews.local` を付けて目印化
//   - shop_reviews: user_id への ON DELETE CASCADE で auth ユーザー削除に連動消去

const TEST_NAME_PREFIX = '__test_shop_reviews_';
const TEST_EMAIL_DOMAIN = '@test-shop-reviews.local';

const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 削除順序:
//   1. テスト auth.users → customers.id 逆引き
//   2. その customers の orders を先に削除（customers→orders は CASCADE ではないため）
//   3. auth.admin.deleteUser → customers / shop_reviews は CASCADE で連動消去
const cleanupTestRows = async (): Promise<void> => {
  const { data, error } = await sbAdmin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`auth.users 一覧取得に失敗: ${error.message}`);
  const testAuthIds = data.users
    .filter((u) => u.email?.endsWith(TEST_EMAIL_DOMAIN))
    .map((u) => u.id);

  if (testAuthIds.length === 0) return;

  const { data: customerRows } = await sbAdmin
    .from('customers')
    .select('id')
    .in('auth_user_id', testAuthIds);
  const customerIds = (customerRows ?? []).map((r) => r.id as string);
  if (customerIds.length > 0) {
    const { error: oErr } = await sbAdmin.from('orders').delete().in('customer_id', customerIds);
    if (oErr) throw new Error(`テスト注文削除失敗: ${oErr.message}`);
  }
  for (const id of testAuthIds) {
    const del = await sbAdmin.auth.admin.deleteUser(id);
    if (del.error) throw new Error(`auth.users 削除失敗 (id=${id}): ${del.error.message}`);
  }
};

// auth.admin.createUser → handle_new_user トリガで customers 行が自動投入される。
// shop_reviews は user_id を auth.users.id に直結する設計なので customers.id は不要。
const seedAuthUser = async (label: string): Promise<string> => {
  const email = `sr-${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}${TEST_EMAIL_DOMAIN}`;
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { name: `${TEST_NAME_PREFIX}reviewer` },
  });
  if (error || !data.user) throw new Error(`auth.user 作成に失敗: ${error?.message ?? '空応答'}`);
  return data.user.id;
};

describe('ShopReviewSupabaseRepository（実 Supabase ローカルに接続）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const repo = new ShopReviewSupabaseRepository(sbAdmin);

  describe('save()', () => {
    it('ShopReview.create() で生成したレビューを保存できる', async () => {
      const authUserId = await seedAuthUser('save-basic');
      const review = ShopReview.create({
        userId: authUserId,
        rating: 5,
        title: '雰囲気がよい',
        body: '接客が丁寧で居心地のよい店でした。',
        isVerifiedCustomer: false,
      });

      await repo.save(review);

      const { data, error } = await sbAdmin
        .from('shop_reviews')
        .select(
          'id, user_id, rating, title, body, status, is_verified_customer, helpful_count, flag_count',
        )
        .eq('id', review.id.value)
        .single();
      expect(error).toBeNull();
      expect(data).toEqual({
        id: review.id.value,
        user_id: authUserId,
        rating: 5,
        title: '雰囲気がよい',
        body: '接客が丁寧で居心地のよい店でした。',
        status: 'published',
        is_verified_customer: false,
        helpful_count: 0,
        flag_count: 0,
      });
    });

    it('同一 user で 2 件目を保存すると ShopReviewAlreadyExistsError（partial unique 違反）', async () => {
      const authUserId = await seedAuthUser('dup');
      const r1 = ShopReview.create({
        userId: authUserId,
        rating: 5,
        title: 't1',
        body: 'b1',
        isVerifiedCustomer: false,
      });
      const r2 = ShopReview.create({
        userId: authUserId,
        rating: 3,
        title: 't2',
        body: 'b2',
        isVerifiedCustomer: false,
      });

      await repo.save(r1);
      await expect(repo.save(r2)).rejects.toBeInstanceOf(ShopReviewAlreadyExistsError);
    });

    it('同一 id を 2 回保存すると ConflictError（PK 違反 → 別エラーパス）', async () => {
      const authUserId = await seedAuthUser('idconflict');
      const review = ShopReview.create({
        userId: authUserId,
        rating: 5,
        title: 't',
        body: 'b',
        isVerifiedCustomer: false,
      });
      await repo.save(review);

      // 同じ ShopReview オブジェクトをもう一度保存 → shop_reviews_pkey 違反で ConflictError 経路を踏む
      await expect(repo.save(review)).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('findById()', () => {
    it('保存したレビューを id で取得できる', async () => {
      const authUserId = await seedAuthUser('find');
      const review = ShopReview.create({
        userId: authUserId,
        rating: 4,
        title: 'tt',
        body: 'bb',
        isVerifiedCustomer: true,
      });
      await repo.save(review);

      const found = await repo.findById(review.id);

      expect(found).not.toBeNull();
      expect(found?.id.value).toBe(review.id.value);
      expect(found?.rating.value).toBe(4);
      expect(found?.isVerifiedCustomer).toBe(true);
      expect(found?.status).toBe('published');
    });

    it('存在しない id は null', async () => {
      const ghost = ReviewId.from('99999999-9999-4999-8999-999999999999');
      const found = await repo.findById(ghost);
      expect(found).toBeNull();
    });
  });

  describe('list()', () => {
    it('status=hidden / removed は除外される（published のみ返す）', async () => {
      const uPub = await seedAuthUser('pub');
      const uHidden = await seedAuthUser('hidden');
      const uRemoved = await seedAuthUser('removed');
      await repo.save(
        ShopReview.create({
          userId: uPub,
          rating: 5,
          title: 't1',
          body: 'b1',
          isVerifiedCustomer: false,
        }),
      );
      // hidden / removed は repo.save() の経路では作れないので sbAdmin 直挿入で seed する
      await sbAdmin.from('shop_reviews').insert([
        {
          id: randomUUID(),
          user_id: uHidden,
          rating: 3,
          title: 't2',
          body: 'b2',
          status: 'hidden',
        },
        {
          id: randomUUID(),
          user_id: uRemoved,
          rating: 2,
          title: 't3',
          body: 'b3',
          status: 'removed',
        },
      ]);

      const page = await repo.list({ limit: 20, sort: 'newest' });
      expect(page.reviews).toHaveLength(1);
      expect(page.reviews[0]?.status).toBe('published');
    });

    it('filterRating で星評価による絞り込みができる', async () => {
      const u1 = await seedAuthUser('fr1');
      const u2 = await seedAuthUser('fr2');
      await repo.save(
        ShopReview.create({
          userId: u1,
          rating: 5,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );
      await repo.save(
        ShopReview.create({
          userId: u2,
          rating: 3,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );

      const page = await repo.list({ limit: 20, sort: 'newest', filterRating: 5 });
      expect(page.reviews).toHaveLength(1);
      expect(page.reviews[0]?.rating.value).toBe(5);
    });

    it('verifiedOnly=true は利用客バッジ付きだけ返す', async () => {
      const u1 = await seedAuthUser('vo1');
      const u2 = await seedAuthUser('vo2');
      await repo.save(
        ShopReview.create({
          userId: u1,
          rating: 5,
          title: 't',
          body: 'b',
          isVerifiedCustomer: true,
        }),
      );
      await repo.save(
        ShopReview.create({
          userId: u2,
          rating: 4,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );

      const page = await repo.list({ limit: 20, sort: 'newest', verifiedOnly: true });
      expect(page.reviews).toHaveLength(1);
      expect(page.reviews[0]?.isVerifiedCustomer).toBe(true);
    });

    it('sort=helpful で helpful_count 降順に並ぶ', async () => {
      const u1 = await seedAuthUser('h1');
      const u2 = await seedAuthUser('h2');
      const u3 = await seedAuthUser('h3');
      // repo.save() は helpful_count を 0 で書き込むため、検証には sbAdmin で直接 helpful_count を埋める
      await sbAdmin.from('shop_reviews').insert([
        {
          id: randomUUID(),
          user_id: u1,
          rating: 5,
          title: 't',
          body: 'b',
          status: 'published',
          helpful_count: 10,
        },
        {
          id: randomUUID(),
          user_id: u2,
          rating: 5,
          title: 't',
          body: 'b',
          status: 'published',
          helpful_count: 5,
        },
        {
          id: randomUUID(),
          user_id: u3,
          rating: 5,
          title: 't',
          body: 'b',
          status: 'published',
          helpful_count: 1,
        },
      ]);

      const page = await repo.list({ limit: 20, sort: 'helpful' });
      expect(page.reviews.map((r) => r.helpfulCount)).toEqual([10, 5, 1]);
    });

    it('sort=newest のカーソルで全件を取りこぼし・重複なく辿れる', async () => {
      const userIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        userIds.push(await seedAuthUser(`pgn${String(i)}`));
      }
      // created_at をずらして時系列を作る
      const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();
      const ids: string[] = [];
      for (let i = 0; i < userIds.length; i += 1) {
        const id = randomUUID();
        ids.push(id);
        await sbAdmin.from('shop_reviews').insert({
          id,
          user_id: userIds[i],
          rating: 5,
          title: 't',
          body: 'b',
          status: 'published',
          created_at: new Date(baseTime + i * 1000).toISOString(),
        });
      }
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after: ReviewListCursor | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await repo.list({ limit: 2, sort: 'newest', ...(after ? { after } : {}) });
        for (const r of page.reviews) {
          if (wanted.has(r.id.value)) collected.push(r.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
      expect(new Set(collected).size).toBe(4);
      expect(collected).toHaveLength(4);
    });

    it('sort=helpful のカーソルでも全件を取りこぼしなく辿れる', async () => {
      const userIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        userIds.push(await seedAuthUser(`ph${String(i)}`));
      }
      const ids: string[] = [];
      for (let i = 0; i < userIds.length; i += 1) {
        const id = randomUUID();
        ids.push(id);
        await sbAdmin.from('shop_reviews').insert({
          id,
          user_id: userIds[i],
          rating: 5,
          title: 't',
          body: 'b',
          status: 'published',
          helpful_count: (i + 1) * 5,
        });
      }
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after: ReviewListCursor | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await repo.list({ limit: 2, sort: 'helpful', ...(after ? { after } : {}) });
        for (const r of page.reviews) {
          if (wanted.has(r.id.value)) collected.push(r.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
      expect(new Set(collected).size).toBe(4);
      expect(collected).toHaveLength(4);
    });
  });

  describe('stats()', () => {
    it('0 件のとき count=0 / average=null / distribution=all 0 を返す', async () => {
      const stats = await repo.stats();
      expect(stats).toEqual({
        count: 0,
        average: null,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      });
    });

    it('count / average / distribution を計算する（hidden は除外）', async () => {
      const u1 = await seedAuthUser('s1');
      const u2 = await seedAuthUser('s2');
      const u3 = await seedAuthUser('s3');
      // 5, 4, 3 → avg = 4
      await repo.save(
        ShopReview.create({
          userId: u1,
          rating: 5,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );
      await repo.save(
        ShopReview.create({
          userId: u2,
          rating: 4,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );
      await repo.save(
        ShopReview.create({
          userId: u3,
          rating: 3,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );
      // hidden は集計対象外
      const uHidden = await seedAuthUser('s-hidden');
      await sbAdmin.from('shop_reviews').insert({
        id: randomUUID(),
        user_id: uHidden,
        rating: 1,
        title: 't',
        body: 'b',
        status: 'hidden',
      });

      const stats = await repo.stats();
      expect(stats.count).toBe(3);
      expect(stats.average).toBe(4);
      expect(stats.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });
    });
  });

  describe('existsActiveByUser()', () => {
    it('published があれば true', async () => {
      const authUserId = await seedAuthUser('e1');
      await repo.save(
        ShopReview.create({
          userId: authUserId,
          rating: 5,
          title: 't',
          body: 'b',
          isVerifiedCustomer: false,
        }),
      );
      expect(await repo.existsActiveByUser(authUserId)).toBe(true);
    });

    it('hidden があっても true（active 扱い）', async () => {
      const authUserId = await seedAuthUser('e2');
      await sbAdmin.from('shop_reviews').insert({
        id: randomUUID(),
        user_id: authUserId,
        rating: 3,
        title: 't',
        body: 'b',
        status: 'hidden',
      });
      expect(await repo.existsActiveByUser(authUserId)).toBe(true);
    });

    it('removed のみなら false（再投稿可とみなす）', async () => {
      const authUserId = await seedAuthUser('e3');
      await sbAdmin.from('shop_reviews').insert({
        id: randomUUID(),
        user_id: authUserId,
        rating: 3,
        title: 't',
        body: 'b',
        status: 'removed',
      });
      expect(await repo.existsActiveByUser(authUserId)).toBe(false);
    });

    it('一件もなければ false', async () => {
      const authUserId = await seedAuthUser('e4');
      expect(await repo.existsActiveByUser(authUserId)).toBe(false);
    });
  });
});
