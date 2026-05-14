import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createOptionalAuthMiddleware } from './auth.middleware';
import type { AppEnv } from './request-context';
import type { Env } from './env';
import type { JwksFetcher, JwksFetcherProvider } from '@/shared/infrastructure/jwks-fetcher';

// ---------------------------------------------------------------------------
// Node ランタイム再現テスト
//   Hono の Context#executionCtx は getter で、ExecutionContext が未注入なら
//   throw する。Workers Adapter を介さず `app.request()` を叩く Node 経路では
//   毎リクエスト getter が throw するため、middleware 側で try/catch していないと
//   500 になる（実機で実際に起きた回帰）。
//   ここでは「getter throw → provider に undefined が渡る → next() に進む」が
//   崩れていないことを検証する。
// ---------------------------------------------------------------------------

const buildEnv = (): Env => ({
  PORT: 3010,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'anon-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test-key',
});

describe('createOptionalAuthMiddleware (Node 経路)', () => {
  it('executionCtx getter が throw しても provider に undefined を渡して次に進む', async () => {
    const fetcher: JwksFetcher = { fetch: vi.fn() };
    const provider: JwksFetcherProvider = vi.fn(() => fetcher);

    const app = new Hono<AppEnv>();
    app.use(createOptionalAuthMiddleware({ env: buildEnv(), jwksFetcherProvider: provider }));
    app.get('/test', (c) => c.json({ ok: true }));

    // app.request() は executionCtx を注入しないため、Hono の getter は throw する。
    // 修正前はここで 500 になっていた。
    const res = await app.request('/test');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(undefined);
  });

  it('Authorization ヘッダなしのリクエストでは JWKS fetch を呼ばない', async () => {
    const fetcher: JwksFetcher = { fetch: vi.fn() };
    const provider: JwksFetcherProvider = vi.fn(() => fetcher);

    const app = new Hono<AppEnv>();
    app.use(createOptionalAuthMiddleware({ env: buildEnv(), jwksFetcherProvider: provider }));
    app.get('/test', (c) => c.json({ user: c.get('user') ?? null }));

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ user: null });
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });
});
