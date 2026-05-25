import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  IdempotencyInProgressError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
} from '@/shared/domain/errors';
import {
  createIdempotencyMiddleware,
  ipOwner,
  noopIdempotencyMiddleware,
  userOwner,
} from './idempotency.middleware';
import type { AppEnv } from '@/shared/http/request-context';
import { InMemoryIdempotencyStore } from '@/shared/infrastructure/idempotency-store';

// ---------------------------------------------------------------------------
// Idempotency-Key middleware の単体テスト。
//
//   - 形式バリデーション（欠落・空・長すぎ・非 ASCII）
//   - 4 状態（inserted / replay / in_progress / mismatch）の振る舞い
//   - replay 時に `Idempotency-Replayed: true` ヘッダが付与されること
//   - owner / scope による隔離
//
// 統合観点（実際のレスポンス body 取得・401 と重ねた挙動）は
// app/__tests__/integration/idempotency.test.ts で workers プールから検証する。
// ---------------------------------------------------------------------------

const buildApp = (store: InMemoryIdempotencyStore) => {
  const app = new Hono<AppEnv>();
  app.use(
    '/orders',
    createIdempotencyMiddleware({
      store,
      scope: 'POST /v1/orders',
      resolveOwner: ipOwner,
    }),
  );
  app.post('/orders', (c) => c.json({ id: 'o1', status: 'placed' }, 201));
  return app;
};

const post = async (
  app: Hono<AppEnv>,
  init: { key?: string; body?: unknown; ip?: string } = {},
): Promise<Response> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.key !== undefined) headers['Idempotency-Key'] = init.key;
  if (init.ip) headers['cf-connecting-ip'] = init.ip;
  return await app.request('/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(init.body ?? { cakeId: 'c1', quantity: 2 }),
  });
};

describe('createIdempotencyMiddleware', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  describe('ヘッダの形式バリデーション', () => {
    it('Idempotency-Key 欠落で IdempotencyKeyRequiredError を throw', async () => {
      const app = buildApp(store);
      app.onError((err) => {
        if (err instanceof IdempotencyKeyRequiredError) {
          return new Response(err.code, { status: err.status });
        }
        throw err;
      });
      const res = await post(app, { key: undefined });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('Idempotency-Key 空文字で 400', async () => {
      const app = buildApp(store);
      app.onError((err) => {
        if (err instanceof IdempotencyKeyRequiredError) {
          return new Response(err.code, { status: err.status });
        }
        throw err;
      });
      const res = await post(app, { key: '' });
      expect(res.status).toBe(400);
    });

    it('Idempotency-Key が 255 文字超で 400', async () => {
      const app = buildApp(store);
      app.onError((err) => {
        if (err instanceof IdempotencyKeyRequiredError) {
          return new Response(err.code, { status: err.status });
        }
        throw err;
      });
      const res = await post(app, { key: 'a'.repeat(256) });
      expect(res.status).toBe(400);
    });

    it('Idempotency-Key に ASCII 非印字可能文字が混じると 400', async () => {
      // マルチバイト文字（'キー-1' 等）は fetch 実装が ByteString として
      // ヘッダ送出する前に弾くため middleware まで到達しない。意味的に近い
      // 「ASCII だが印字不能（0x01）」をテストして regex の網羅を検証する。
      const app = buildApp(store);
      app.onError((err) => {
        if (err instanceof IdempotencyKeyRequiredError) {
          return new Response(err.code, { status: err.status });
        }
        throw err;
      });
      const res = await post(app, { key: 'k\x01-1' });
      expect(res.status).toBe(400);
    });
  });

  describe('正常系: inserted → 完了後 replay', () => {
    it('初回は handler が実行され 201 を返す', async () => {
      const app = buildApp(store);
      const res = await post(app, { key: 'k-1' });
      expect(res.status).toBe(201);
      expect(res.headers.get('Idempotency-Replayed')).toBeNull();
      expect(await res.json()).toEqual({ id: 'o1', status: 'placed' });
    });

    it('同じ key + 同じ body で再送すると 1 回目のレスポンスを replay する', async () => {
      const app = buildApp(store);
      await post(app, { key: 'k-1', body: { cakeId: 'c1', quantity: 2 } });
      const res = await post(app, { key: 'k-1', body: { cakeId: 'c1', quantity: 2 } });

      expect(res.status).toBe(201);
      expect(res.headers.get('Idempotency-Replayed')).toBe('true');
      expect(await res.json()).toEqual({ id: 'o1', status: 'placed' });
    });

    it('JSON プロパティ順序が違っても同じ body として扱う（canonical 化）', async () => {
      const app = buildApp(store);
      await post(app, { key: 'k-1', body: { cakeId: 'c1', quantity: 2 } });
      const res = await post(app, { key: 'k-1', body: { quantity: 2, cakeId: 'c1' } });

      expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    });
  });

  describe('異常系', () => {
    it('同じ key + 違う body で IdempotencyKeyReusedError（422）', async () => {
      const app = buildApp(store);
      app.onError((err) => {
        if (err instanceof IdempotencyKeyReusedError) {
          return new Response(err.code, { status: err.status });
        }
        throw err;
      });
      await post(app, { key: 'k-1', body: { cakeId: 'c1', quantity: 2 } });
      const res = await post(app, { key: 'k-1', body: { cakeId: 'c1', quantity: 99 } });
      expect(res.status).toBe(422);
      expect(await res.text()).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('進行中の予約に同じ key で再 POST すると IdempotencyInProgressError（409）', async () => {
      // 直接 store を操作して in_progress を再現する（middleware を 2 回並列実行する代替）。
      const app = buildApp(store);
      app.onError((err) => {
        if (err instanceof IdempotencyInProgressError) {
          return new Response(err.code, { status: err.status });
        }
        throw err;
      });

      // 同じハッシュになる canonical JSON を直接予約しておく。
      // body の canonical 化結果は `{"cakeId":"c1","quantity":2}` で固定なので、
      // その SHA-256 を計算するために 1 度 middleware を通して inserted を得てから
      // 「complete を呼ばずに」次の POST を投げると in_progress 経路に入る。
      // → 実装上は store を直接書き込むのが最短。
      const encoded = new TextEncoder().encode('{"cakeId":"c1","quantity":2}');
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      await store.tryReserve({
        key: 'k-1',
        ownerType: 'ip',
        ownerId: 'anonymous',
        scope: 'POST /v1/orders',
        requestHash: hex,
      });

      const res = await post(app, { key: 'k-1', body: { cakeId: 'c1', quantity: 2 } });
      expect(res.status).toBe(409);
      expect(await res.text()).toBe('IDEMPOTENCY_IN_PROGRESS');
    });
  });

  describe('スコープ / オーナーによる隔離', () => {
    it('owner（IP）が違えば同じ key を再利用しても inserted', async () => {
      const app = buildApp(store);
      await post(app, { key: 'k-1', ip: '1.1.1.1' });
      const res = await post(app, { key: 'k-1', ip: '2.2.2.2' });
      expect(res.status).toBe(201);
      expect(res.headers.get('Idempotency-Replayed')).toBeNull();
    });

    it('scope が違えば衝突しない', async () => {
      const app = new Hono<AppEnv>();
      app.use(
        '/orders',
        createIdempotencyMiddleware({
          store,
          scope: 'POST /v1/orders',
          resolveOwner: ipOwner,
        }),
      );
      app.use(
        '/customers',
        createIdempotencyMiddleware({
          store,
          scope: 'POST /v1/customers',
          resolveOwner: ipOwner,
        }),
      );
      app.post('/orders', (c) => c.json({ kind: 'order' }, 201));
      app.post('/customers', (c) => c.json({ kind: 'customer' }, 201));

      const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-1' };
      const a = await app.request('/orders', { method: 'POST', headers, body: '{}' });
      const b = await app.request('/customers', { method: 'POST', headers, body: '{}' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers.get('Idempotency-Replayed')).toBeNull();
    });
  });

  describe('OwnerResolver', () => {
    it('userOwner は c.get("user") が無ければ ip にフォールバックする', () => {
      // c.get('user') = undefined を模した最小モック。
      const fakeCtx = {
        get: () => undefined,
        req: { header: (name: string) => (name === 'cf-connecting-ip' ? '9.9.9.9' : undefined) },
      } as unknown as Parameters<typeof userOwner>[0];
      expect(userOwner(fakeCtx)).toEqual({ ownerType: 'ip', ownerId: '9.9.9.9' });
    });

    it('userOwner は user.id があれば user 型を返す', () => {
      const fakeCtx = {
        get: (key: string) => (key === 'user' ? { id: 'u-42' } : undefined),
        req: { header: () => undefined },
      } as unknown as Parameters<typeof userOwner>[0];
      expect(userOwner(fakeCtx)).toEqual({ ownerType: 'user', ownerId: 'u-42' });
    });

    it('ipOwner は cf-connecting-ip 未設定で anonymous', () => {
      const fakeCtx = {
        get: () => undefined,
        req: { header: () => undefined },
      } as unknown as Parameters<typeof ipOwner>[0];
      expect(ipOwner(fakeCtx)).toEqual({ ownerType: 'ip', ownerId: 'anonymous' });
    });
  });

  describe('noopIdempotencyMiddleware', () => {
    it('Idempotency-Key が無くても通過する', async () => {
      const app = new Hono<AppEnv>();
      app.use('/orders', noopIdempotencyMiddleware);
      app.post('/orders', (c) => c.json({ id: 'o1' }, 201));

      const res = await app.request('/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(201);
    });
  });
});
