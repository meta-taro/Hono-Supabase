import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Cake } from '../domain/cake';
import { ConflictError } from '@/shared/domain/errors';
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
// （本プロジェクトの cakes テーブルは現状 anon に SELECT しか許可していないため、
//  テストで挿入・削除するには service_role が必要。Phase 6 で管理者ロール用ポリシーを追加する。）
const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// テスト目印付きの行のみを削除する。
// `like('name', '__test_cake_%')` は SQL の `where name like '__test_cake_%'` と同じ意味で、
// このプレフィックスで始まる行のみを対象にする。
const cleanupTestRows = async (): Promise<void> => {
  const { error } = await sbAdmin.from('cakes').delete().like('name', `${TEST_NAME_PREFIX}%`);
  if (error) {
    throw new Error(`テストデータの掃除に失敗: ${error.message}`);
  }
};

describe('CakeSupabaseRepository（実 Supabase ローカルに接続）', () => {
  // 各テスト前に過去の残骸を消す。afterEach ではなく beforeEach にしているのは、
  // テスト失敗時に Studio で DB の状態を覗いてデバッグできるようにするため。
  beforeEach(cleanupTestRows);
  // 全テスト後にも念のため掃除しておく（次回 `pnpm test` 実行時に冪等性を保つのは
  // beforeEach の役割だが、開発体験として「テスト後に DB を綺麗な状態で残す」方が望ましい）。
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

      // DB に行が入ったかを直接確認する（Repository の list() ではなく素の SELECT）。
      // ここで select() を使うのは、save() のテストが list() の正しさに依存しないようにするため。
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
      // 同じ Cake インスタンスを 2 回 save() すると、2 回目で primary key 衝突が起きる。
      // CakeSupabaseRepository は Postgres の 23505（unique_violation）を ConflictError に変換する。
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

      const page = await repo.list({ limit: LARGE_LIMIT });
      const testCakes = page.cakes.filter((c) => c.name.startsWith(TEST_NAME_PREFIX));

      expect(testCakes).toHaveLength(2);
      // CakeSupabaseRepository.list() は name 昇順で返すので a → b の順
      expect(testCakes.map((c) => c.name)).toEqual([
        `${TEST_NAME_PREFIX}a-モンブラン`,
        `${TEST_NAME_PREFIX}b-ティラミス`,
      ]);
    });

    it('name 昇順でソートされる', async () => {
      // 投入順と期待ソート順が異なるよう、c → a → b の順で登録する。
      // list() が DB 側の `order by name` を使っていれば、結果は a → b → c になる。
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}c`, price: 500, stock: 1 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}a`, price: 500, stock: 1 }));
      await repo.save(Cake.create({ name: `${TEST_NAME_PREFIX}b`, price: 500, stock: 1 }));

      const page = await repo.list({ limit: LARGE_LIMIT });
      const testNames = page.cakes.map((c) => c.name).filter((n) => n.startsWith(TEST_NAME_PREFIX));

      expect(testNames).toEqual([
        `${TEST_NAME_PREFIX}a`,
        `${TEST_NAME_PREFIX}b`,
        `${TEST_NAME_PREFIX}c`,
      ]);
    });

    it('Repository が返す Cake は domain の不変条件を満たす（reconstruct() 経由）', async () => {
      // DB 由来データであっても、Cake.reconstruct() を必ず通すことで
      // VO（CakeId / Price）の検証が走る。これにより壊れたデータが domain 層に
      // 流れ込むのを fail-fast で防ぐ。
      const cake = Cake.create({
        name: `${TEST_NAME_PREFIX}復元確認`,
        price: 1234,
        stock: 7,
      });
      await repo.save(cake);

      const page = await repo.list({ limit: LARGE_LIMIT });
      const reconstructed = page.cakes.find((c) => c.id.value === cake.id.value);

      expect(reconstructed).toBeDefined();
      // VO 経由で値が取り出せる = 検証を通過している証拠
      expect(reconstructed?.id.value).toBe(cake.id.value);
      expect(reconstructed?.price.value).toBe(1234);
      expect(reconstructed?.stock).toBe(7);
    });
  });

  describe('list() のページネーション（キーセット法）', () => {
    // 名前を辞書順で固定し、prefix で他データから隔離しつつ複数ページを検証する。
    // 名前の数字を 2 桁ゼロ詰めにして name 昇順が投入順と一致するようにする。
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

      const page = await repo.list({ limit: 2 });
      // 他データが混じり得るので「テスト行が想定順で含まれるか」をスコープして確認する。
      // ただし limit=2 は全データ横断なので、ここでは nextCursor が出ることだけを保証する。
      expect(page.cakes).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
    });

    it('nextCursor を after に渡して全ページを辿ると、テスト投入分を重複なく取得できる', async () => {
      const ids = await seedSequentialCakes(5);
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after = undefined as { name: string; id: string } | undefined;
      // 2 件ずつ。seed/他データ込みなので十分な回数ループして全ページを舐める。
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await repo.list({ limit: 2, after });
        for (const cake of page.cakes) {
          if (wanted.has(cake.id.value)) collected.push(cake.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }

      // 5 件すべてが重複なく 1 回ずつ取得できている（同名 prefix の境界またぎ耐性）
      expect(new Set(collected).size).toBe(5);
      expect(collected).toHaveLength(5);
    });

    it('同名ケーキが複数あっても (name,id) 複合キーで取りこぼさない', async () => {
      // name を完全に同一にして 4 件投入。name だけのカーソルだと境界で重複/欠落する。
      const sameName = `${TEST_NAME_PREFIX}same`;
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const cake = Cake.create({ name: sameName, price: 500, stock: 1 });
        await repo.save(cake);
        ids.push(cake.id.value);
      }
      const wanted = new Set(ids);

      const collected: string[] = [];
      let after = undefined as { name: string; id: string } | undefined;
      for (let guard = 0; guard < 1000; guard += 1) {
        const page = await repo.list({ limit: 1, after });
        for (const cake of page.cakes) {
          if (wanted.has(cake.id.value)) collected.push(cake.id.value);
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }

      expect(new Set(collected).size).toBe(4);
      expect(collected).toHaveLength(4);
    });
  });
});
