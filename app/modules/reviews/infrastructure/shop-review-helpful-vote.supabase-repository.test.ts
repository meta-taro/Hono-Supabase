import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import { ShopReviewSupabaseRepository } from './shop-review.supabase-repository';
import { ShopReviewHelpfulVoteSupabaseRepository } from './shop-review-helpful-vote.supabase-repository';
import { loadEnv, type RawEnv } from '@/shared/http/env';

// 実 Supabase ローカルに対して動く（`supabase start` 前提）。
// 分離戦略は他レビュー系テストと同じ（@test-reviews.local の auth ユーザーのみ作成・cleanup）。
// shop_reviews は単一店舗・cake_id を持たないため cake の seed は不要。
// 投票行は user_id / review_id への ON DELETE CASCADE で親削除に連動消去される。

const TEST_EMAIL_DOMAIN = '@test-reviews.local';

const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// テスト auth.users を削除すると shop_reviews / 投票行は CASCADE で連動消去される。
const cleanupTestRows = async (): Promise<void> => {
  const { data, error } = await sbAdmin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`auth.users 一覧取得に失敗: ${error.message}`);
  const testAuthIds = data.users
    .filter((u) => u.email?.endsWith(TEST_EMAIL_DOMAIN))
    .map((u) => u.id);

  if (testAuthIds.length > 0) {
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
  }
};

const seedAuthUser = async (label: string): Promise<string> => {
  const email = `srv-${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}${TEST_EMAIL_DOMAIN}`;
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { name: 'shop voter' },
  });
  if (error || !data.user) throw new Error(`auth.user 作成に失敗: ${error?.message ?? '空応答'}`);
  return data.user.id;
};

// 公開済み店舗レビューを 1 件作って ShopReview を返す（投票対象）。
const seedPublishedReview = async (authorId: string): Promise<ShopReview> => {
  const reviewRepo = new ShopReviewSupabaseRepository(sbAdmin);
  const review = ShopReview.create({
    userId: authorId,
    rating: 5,
    title: '良いお店',
    body: '接客が丁寧でケーキも美味しかったです。',
    isVerifiedCustomer: false,
  });
  await reviewRepo.save(review);
  return review;
};

const readHelpfulCount = async (reviewId: string): Promise<number> => {
  const { data, error } = await sbAdmin
    .from('shop_reviews')
    .select('helpful_count')
    .eq('id', reviewId)
    .single();
  if (error || !data) throw new Error(`helpful_count 取得失敗: ${error?.message}`);
  return data.helpful_count as number;
};

describe('ShopReviewHelpfulVoteSupabaseRepository（実 Supabase ローカルに接続）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const repo = new ShopReviewHelpfulVoteSupabaseRepository(sbAdmin);

  it('add() でトリガが shop_reviews.helpful_count を 1 に増やし、countByReview も 1 を返す', async () => {
    const author = await seedAuthUser('add-author');
    const voter = await seedAuthUser('add-voter');
    const review = await seedPublishedReview(author);

    await repo.add(review.id, voter);

    expect(await readHelpfulCount(review.id.value)).toBe(1);
    expect(await repo.countByReview(review.id)).toBe(1);
  });

  it('同一ユーザーの 2 回 add は二重カウントしない（冪等）', async () => {
    const author = await seedAuthUser('dup-author');
    const voter = await seedAuthUser('dup-voter');
    const review = await seedPublishedReview(author);

    await repo.add(review.id, voter);
    await repo.add(review.id, voter);

    expect(await repo.countByReview(review.id)).toBe(1);
  });

  it('複数ユーザーの投票はそれぞれ加算される', async () => {
    const author = await seedAuthUser('multi-author');
    const v1 = await seedAuthUser('multi-v1');
    const v2 = await seedAuthUser('multi-v2');
    const review = await seedPublishedReview(author);

    await repo.add(review.id, v1);
    await repo.add(review.id, v2);

    expect(await repo.countByReview(review.id)).toBe(2);
  });

  it('remove() でトリガが helpful_count を減らす', async () => {
    const author = await seedAuthUser('rm-author');
    const voter = await seedAuthUser('rm-voter');
    const review = await seedPublishedReview(author);
    await repo.add(review.id, voter);

    await repo.remove(review.id, voter);

    expect(await readHelpfulCount(review.id.value)).toBe(0);
    expect(await repo.countByReview(review.id)).toBe(0);
  });

  it('未投票の remove は no-op（カウントは変化しない）', async () => {
    const author = await seedAuthUser('noop-author');
    const voter = await seedAuthUser('noop-voter');
    const review = await seedPublishedReview(author);

    await repo.remove(review.id, voter);

    expect(await repo.countByReview(review.id)).toBe(0);
  });
});
