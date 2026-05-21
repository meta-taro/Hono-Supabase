import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Cake } from '../domain/cake';
import { ConflictError } from '@/shared/domain/errors';
import {
  DEFAULT_CAKE_SORT,
  type CakeListCursor,
  type CakeSortKey,
  type ListCakesParams,
} from '../domain/cake.repository';
import { CakeSupabaseRepository } from './cake.supabase-repository';
import { loadEnv, type RawEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカルに対して動く」ことの確認なので、
// 起動済みの Supabase（`supabase start`）が必要。
// vitest-pool-workers では miniflare.bindings を `cloudflare:test` の env 経由で受け取る
// （process.env は workerd 上では空。Node 側と挙動を揃えるため loadEnv() に注入する）。

// テストデータの目印。
// このプレフィックスで始まる行だけを掃除対象にすることで、
// seed.sql / 手動登録（Studio や Bruno 経由）のデータには絶対に触れない。
const TEST_NAME_PREFIX = '__test_cake_';

// service_role キーで RLS をバイパスして cakes に INSERT/DELETE する。
const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// list() の定型パラメータ（sort / filter は必須）を埋める薄いヘルパ。
const listParams = (over: Partial<ListCakesParams> = {}): ListCakesParams => ({
  limit: 20,
  sort: [...DEFAULT_CAKE_SORT],
  filter: {},
  ...over,
});

const cleanupTestRows = async (): Promise<void> => {
  const { error } = await sbAdmin.from('cakes').delete().like('name', `${TEST_NAME_PREFIX}%`);
  if (error) {
    throw new Error(`テストデータの掃除に失敗: ${error.message}`);
  }
};

describe('CakeSupabaseRepository（実 Supabase ローカルに接続）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const repo = new CakeSupabaseRepository(sbAdmin);

  describe('save()', () => {
    it('Cake.create() で生成したケーキを保存できる', async () => {
      const cake = Cake.create({
        name: `${TEST_NAME_PREFIX}ショートケーキ`,
        price: 480,
        stock: 20,
      });

      await repo.save(cake);

      const { data, error } = await sbAdmin
        .from('cakes')
        .select('id, name, price, stock')
        .eq('id', cake.id.value)
        .single();

      expect(error).toBeNull();
      expect(data).toEqual({
        id: cake.id.value,
        name: `${TEST_NAME_PREFIX}ショートケーキ`,
        price: 480,
        stock: 20,
      });
    });

    it('同一 ID で 2 回保存すると ConflictError を投げる', async () => {
      const cake = Cake.create({
        name: `${TEST_NAME_PREFIX}重複テスト`,
        price: 500,
        stock: 5,
      });

      await repo.save(cake);
      await expect(repo.save(cake)).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('list()', () => {
    // seed.sql の 5 件や手動登録データと共存するため、十分大きな limit で全件取り、
    // テスト目印付きの行だけにフィルタしてアサーションする（行レベル prefix 隔離）。
    const LARGE_LIMIT = 1000;

    it('保存したケーキを取得できる', async () => {
      const cakeA = Cake.create({
        name: `${TEST_NAME_PREFIX}a-モンブラン`,
        price: 600,
        stock: 10,
      });
      const cakeB = Cake.create({
        name: `${TEST_NAME_PREFIX}b-ティラミス`,
        price: 700,
        stock: 5,
      });
      await repo.save(cakeA);
      await repo.save(cakeB);

      const page = await repo.list(listParams({ limit: LARGE_LIMIT }));
      const testCakes = page.cakes.filter((c) => c.name.startsWith(TEST_NAME_PREFIX));

      expect(testCakes).toHaveLength(2);
      expect(testCakes.map((c) => c.name)).toEqual([
        `${TEST_NAME_PREFIX}a-モンブラン`,
        `${TEST_NAME_PREFIX}b-ティラミス`,
      ]);
    });

    it('name 昇順でソートされる', async () => {
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}c`, price: 500, stock: 1 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}a`, price: 500, stock: 1 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}b`, price: 500, stock: 1 }));

      const page = await repo.list(listParams({ limit: LARGE_LIMIT }));
      const testNames = page.cakes.map((c) => c.name).filter((n) => n.startsWith(TEST_NAME_PREFIX));

      expect(testNames).toEqual([
        `${TEST_NAME_PREFIX}a`,
        `${TEST_NAME_PREFIX}b`,
        `${TEST_NAME_PREFIX}c`,
      ]);
    });

    it('Repository が返す Cake は domain の不変条件を満たす（reconstruct() 経由）', async () => {
      const cake = Cake.create({
        name: `${TEST_NAME_PREFIX}復元確認`,
        price: 1234,
        stock: 7,
      });
      await repo.save(cake);

      const page = await repo.list(listParams({ limit: LARGE_LIMIT }));
      const reconstructed = page.cakes.find((c) => c.id.value === cake.id.value);

      expect(reconstructed).toBeDefined();
      expect(reconstructed?.id.value).toBe(cake.id.value);
      expect(reconstructed?.price.value).toBe(1234);
      expect(reconstructed?.stock).toBe(7);
    });
  });

  describe('list() のソート（Phase 10 Step 2）', () => {
    const LARGE_LIMIT = 1000;

    it('price 降順でソートできる', async () => {
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}s-low`, price: 300, stock: 1 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}s-high`, price: 900, stock: 1 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}s-mid`, price: 600, stock: 1 }));

      const page = await repo.list(
        listParams({ limit: LARGE_LIMIT, sort: [{ field: 'price', direction: 'desc' }] }),
      );
      const testPrices = page.cakes
        .filter((c) => c.name.startsWith(`${TEST_NAME_PREFIX}s-`))
        .map((c) => c.price.value);

      // 全データ横断だが、テスト行だけ抜き出した相対順序は降順になっているはず
      expect(testPrices).toEqual([900, 600, 300]);
    });
  });

  describe('list() のフィルタ（Phase 10 Step 2）', () => {
    const LARGE_LIMIT = 1000;

    const seedFilterFixtures = async (): Promise<void> => {
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}f-soldout`, price: 500, stock: 0 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}f-cheap`, price: 300, stock: 5 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}f-pricey`, price: 1200, stock: 2 }));
    };

    it('available=true は在庫ありだけ返す', async () => {
      await seedFilterFixtures();
      const page = await repo.list(listParams({ limit: LARGE_LIMIT, filter: { available: true } }));
      const names = page.cakes
        .filter((c) => c.name.startsWith(`${TEST_NAME_PREFIX}f-`))
        .map((c) => c.name);
      expect(names.sort()).toEqual([`${TEST_NAME_PREFIX}f-cheap`, `${TEST_NAME_PREFIX}f-pricey`]);
    });

    it('minPrice / maxPrice で価格帯を絞る（在庫の有無は無関係）', async () => {
      await seedFilterFixtures();
      const page = await repo.list(
        listParams({ limit: LARGE_LIMIT, filter: { minPrice: 300, maxPrice: 600 } }),
      );
      const testCakes = page.cakes.filter((c) => c.name.startsWith(`${TEST_NAME_PREFIX}f-`));
      // f-cheap(300) と f-soldout(500) が範囲内（f-pricey=1200 は範囲外）
      expect(testCakes.map((c) => c.name).sort()).toEqual([
        `${TEST_NAME_PREFIX}f-cheap`,
        `${TEST_NAME_PREFIX}f-soldout`,
      ]);
    });

    it('nameSearch で全文検索できる（PGroonga search_cakes RPC 経由）', async () => {
      await seedFilterFixtures();
      const page = await repo.list(
        listParams({ limit: LARGE_LIMIT, filter: { nameSearch: 'pricey' } }),
      );
      const testCakes = page.cakes.filter((c) => c.name.startsWith(`${TEST_NAME_PREFIX}f-`));
      expect(testCakes.map((c) => c.name)).toEqual([`${TEST_NAME_PREFIX}f-pricey`]);
    });

    it('nameSearch は日本語の N-gram 部分一致を拾う（pg_trgm では難しい 2 文字も）', async () => {
      await repo.save(
        Cake.create({ name: `${TEST_NAME_PREFIX}いちごのショートケーキ`, price: 480, stock: 5 }),
      );
      await repo.save(
        Cake.create({ name: `${TEST_NAME_PREFIX}抹茶ロールケーキ`, price: 520, stock: 5 }),
      );
      await repo.save(
        Cake.create({ name: `${TEST_NAME_PREFIX}チョコレートケーキ`, price: 600, stock: 5 }),
      );

      // ひらがな部分一致: 「いちご」が名前の途中にあっても拾える
      const ichigo = await repo.list(
        listParams({ limit: LARGE_LIMIT, filter: { nameSearch: 'いちご' } }),
      );
      expect(ichigo.cakes.map((c) => c.name)).toContain(
        `${TEST_NAME_PREFIX}いちごのショートケーキ`,
      );

      // 2 文字クエリ「抹茶」も N-gram 索引で拾える（pg_trgm のトライグラム最小 3 文字制約が無い）
      const matcha = await repo.list(
        listParams({ limit: LARGE_LIMIT, filter: { nameSearch: '抹茶' } }),
      );
      const matchaNames = matcha.cakes
        .filter((c) => c.name.startsWith(TEST_NAME_PREFIX))
        .map((c) => c.name);
      expect(matchaNames).toEqual([`${TEST_NAME_PREFIX}抹茶ロールケーキ`]);
    });
  });

  describe('list() のページネーション（キーセット法）', () => {
    const seedSequentialCakes = async (count: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const cake = Cake.create({
          name: `${TEST_NAME_PREFIX}p${String(i).padStart(2, '0')}`,
          price: 500,
          stock: 1,
        });
        await repo.save(cake);
        ids.push(cake.id.value);
      }
      return ids;
    };

    it('limit 件ちょうど返し、続きがあれば nextCursor を発行する', async () => {
      await seedSequentialCakes(3);

      const page = await repo.list(listParams({ limit: 2 }));
      expect(page.cakes).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
    });

    it('nextCursor を after に渡して全ページを辿ると、テスト投入分を重複なく取得できる', async () => {
      const ids = await seedSequentialCakes(5);
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after: CakeListCursor | undefined = undefined;
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await repo.list(listParams({ limit: 2, after }));
        for (const cake of page.cakes) {
          if (wanted.has(cake.id.value)) collected.push(cake.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }

      expect(new Set(collected).size).toBe(5);
      expect(collected).toHaveLength(5);
    });

    it('同名ケーキが複数あっても (name,id) 複合キーで取りこぼさない', async () => {
      const sameName = `${TEST_NAME_PREFIX}same`;
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const cake = Cake.create({ name: sameName, price: 500, stock: 1 });
        await repo.save(cake);
        ids.push(cake.id.value);
      }
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after: CakeListCursor | undefined = undefined;
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await repo.list(listParams({ limit: 1, after }));
        for (const cake of page.cakes) {
          if (wanted.has(cake.id.value)) collected.push(cake.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }

      expect(new Set(collected).size).toBe(4);
      expect(collected).toHaveLength(4);
    });

    it('price 降順のカーソルでも全ページを重複なく辿れる（非デフォルトソート）', async () => {
      // price をばらけさせて投入し、price 降順 + id tiebreaker のキーセットを検証する。
      const sort: CakeSortKey[] = [{ field: 'price', direction: 'desc' }];
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const cake = Cake.create({
          name: `${TEST_NAME_PREFIX}ks${String(i).padStart(2, '0')}`,
          price: 1000 - i * 10,
          stock: 1,
        });
        await repo.save(cake);
        ids.push(cake.id.value);
      }
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after: CakeListCursor | undefined = undefined;
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await repo.list(listParams({ limit: 2, sort, after }));
        for (const cake of page.cakes) {
          if (wanted.has(cake.id.value)) collected.push(cake.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }

      expect(new Set(collected).size).toBe(5);
      expect(collected).toHaveLength(5);
    });
  });
});
