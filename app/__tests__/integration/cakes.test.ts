import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { createApp } from '@/app';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { InMemoryCakeRepository } from '@/modules/cakes/application/__test-helpers__/in-memory-cake.repository';
import { Cake } from '@/modules/cakes/domain/cake';

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   - Zod 検証 → 400 統一エラー形式
//   - 正常系のステータス / レスポンス形
//   - domain 例外（ConflictError 等）→ 適切な HTTP ステータス
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は cake.supabase-repository.test.ts で実 Supabase に対して
//   既に検証済み。ここでは「HTTP → UseCase → Response」の経路だけを高速・決定的に確認する。
//   InMemoryCakeRepository を使うことで、DB 抜きで上から下までフルスタックで動かせる
//   ＝ DDD-lite の利点（domain interface の差し替え可能性）の体現。
// ---------------------------------------------------------------------------

// ログ出力をテスト中に抑制（pino の silent レベル）。
// テスト失敗時のデバッグで一時的に 'info' に変えると log が見える。
const silentLogger = pino({ level: 'silent' });

interface TestApp {
  app: ReturnType<typeof createApp>;
  repo: InMemoryCakeRepository;
}

const buildTestApp = (): TestApp => {
  const repo = new InMemoryCakeRepository();
  const listCakes = createListCakesUseCase(repo);
  const createCake = createCreateCakeUseCase(repo, silentLogger);
  const controller = createCakeController({ listCakes, createCake });
  const cakesRouter = createCakeRouter(controller);
  const app = createApp({ cakesRouter });
  return { app, repo };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('GET /v1/cakes', () => {
  it('リポジトリが空のときは空配列を返す', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/cakes');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cakes: [] });
  });

  it('保存済みケーキを Response DTO 形式で返す', async () => {
    const { app, repo } = buildTestApp();
    await repo.save(Cake.create({ name: 'モンブラン', price: 600, stock: 10 }));

    const res = await app.request('/v1/cakes');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cakes: Array<{ id: string; name: string; price: number; stock: number }>;
    };
    expect(body.cakes).toHaveLength(1);
    expect(body.cakes[0]).toMatchObject({
      name: 'モンブラン',
      price: 600,
      stock: 10,
    });
    // id は UUID v4 形式である
    expect(body.cakes[0]?.id).toMatch(UUID_REGEX);
  });
});

describe('POST /v1/cakes', () => {
  it('201 と作成されたケーキを返す（Cake.create で UUID 自動採番）', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/cakes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ガトーショコラ', price: 700, stock: 5 }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      price: number;
      stock: number;
    };
    expect(body).toMatchObject({
      name: 'ガトーショコラ',
      price: 700,
      stock: 5,
    });
    expect(body.id).toMatch(UUID_REGEX);
  });

  it('保存後に GET /v1/cakes で取得できる（ラウンドトリップ）', async () => {
    // POST → GET の連鎖で、状態が UseCase / Repository を経由して保たれることを確認する。
    const { app } = buildTestApp();

    const postRes = await app.request('/v1/cakes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ティラミス', price: 650, stock: 8 }),
    });
    expect(postRes.status).toBe(201);

    const getRes = await app.request('/v1/cakes');
    const body = (await getRes.json()) as { cakes: Array<{ name: string }> };
    expect(body.cakes.map((c) => c.name)).toEqual(['ティラミス']);
  });

  describe('Zod バリデーション失敗', () => {
    it('name が空のとき 400 + VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', price: 500, stock: 5 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: Array<{ field: string; message: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name' }),
        ]),
      );
    });

    it('price が範囲外（0）のとき 400 を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', price: 0, stock: 5 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'price')).toBe(true);
    });

    it('stock が負のとき 400 を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', price: 500, stock: -1 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'stock')).toBe(true);
    });

    it('複数フィールドが不正のとき details に複数件含まれる', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', price: -1, stock: -1 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { details?: Array<{ field: string }> };
      };
      // Zod は最初のエラーで止まらず全フィールドを検証する
      expect(body.error.details?.length).toBeGreaterThanOrEqual(2);
    });
  });
});
