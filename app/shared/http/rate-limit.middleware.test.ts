import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  createRateLimitMiddleware,
  ipKey,
  noopRateLimitMiddleware,
  restrictToMethods,
  userOrIpKey,
} from './rate-limit.middleware';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter';
import { createErrorHandler } from './error-handler';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import type { AppEnv, AuthUser } from './request-context';

// ---------------------------------------------------------------------------
// 各テストは「Hono に middleware を挟んで app.request() で叩く」共通パターン。
// error-handler を通すことで RateLimitedError → 429 + Retry-After + 統一エラー本文
// までの一気通貫を確認する（middleware 単独では throw までしか検証できないため）。
// ---------------------------------------------------------------------------

const buildAppWithMiddleware = (limiter: RateLimiter, retryAfterSec = 10) => {
  const app = new Hono<AppEnv>();
  app.use(
    createRateLimitMiddleware({
      limiter,
      retryAfterSec,
      resolveKey: ipKey,
    }),
  );
  app.get('/test', (c) => c.json({ ok: true }));
  app.onError(createErrorHandler(createSilentLogger()));
  return app;
};

describe('createRateLimitMiddleware', () => {
  it('limit 内では next() に進み 200 を返す', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 3, periodSec: 10, now: () => 1000 });
    const app = buildAppWithMiddleware(limiter);

    const res = await app.request('/test', {
      headers: { 'cf-connecting-ip': '203.0.113.1' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('limit 超過で 429 + Retry-After ヘッダ + 統一エラー本文を返す', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, periodSec: 10, now: () => 1000 });
    const app = buildAppWithMiddleware(limiter, 10);

    // 1 回目は通る、2 回目で 429。
    await app.request('/test', { headers: { 'cf-connecting-ip': '203.0.113.1' } });
    const res = await app.request('/test', { headers: { 'cf-connecting-ip': '203.0.113.1' } });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'リクエスト数が上限を超えました',
        details: [{ field: 'Retry-After', message: '10' }],
      },
    });
  });

  it('別 IP は独立してカウントされる', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, periodSec: 10, now: () => 1000 });
    const app = buildAppWithMiddleware(limiter);

    const r1 = await app.request('/test', { headers: { 'cf-connecting-ip': 'a' } });
    const r2 = await app.request('/test', { headers: { 'cf-connecting-ip': 'a' } });
    const r3 = await app.request('/test', { headers: { 'cf-connecting-ip': 'b' } });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    expect(r3.status).toBe(200);
  });

  it('cf-connecting-ip がない場合は anonymous key で評価する', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) } satisfies RateLimiter;
    const app = new Hono<AppEnv>();
    app.use(
      createRateLimitMiddleware({
        limiter,
        retryAfterSec: 10,
        resolveKey: ipKey,
      }),
    );
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test');
    expect(limiter.limit).toHaveBeenCalledWith({ key: 'ip:anonymous' });
  });

  it('userOrIpKey は認証済みなら user キー、未認証なら ip キーを使う', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) } satisfies RateLimiter;

    // 認証済みケース: 事前ミドルウェアで c.set('user', ...) しておく。
    const authedUser: AuthUser = { id: 'user-1', role: 'authenticated' };
    const authedApp = new Hono<AppEnv>();
    authedApp.use(async (c, next) => {
      c.set('user', authedUser);
      await next();
    });
    authedApp.use(
      createRateLimitMiddleware({ limiter, retryAfterSec: 10, resolveKey: userOrIpKey }),
    );
    authedApp.get('/test', (c) => c.json({ ok: true }));

    await authedApp.request('/test', { headers: { 'cf-connecting-ip': '203.0.113.1' } });
    expect(limiter.limit).toHaveBeenLastCalledWith({ key: 'user:user-1' });

    // 未認証ケース。
    const anonApp = new Hono<AppEnv>();
    anonApp.use(createRateLimitMiddleware({ limiter, retryAfterSec: 10, resolveKey: userOrIpKey }));
    anonApp.get('/test', (c) => c.json({ ok: true }));

    await anonApp.request('/test', { headers: { 'cf-connecting-ip': '203.0.113.1' } });
    expect(limiter.limit).toHaveBeenLastCalledWith({ key: 'ip:203.0.113.1' });
  });
});

describe('noopRateLimitMiddleware', () => {
  it('limiter を呼ばずに next() を通す（binding 未注入時のフォールバック）', async () => {
    const app = new Hono<AppEnv>();
    app.use(noopRateLimitMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});

describe('restrictToMethods', () => {
  it('指定 method のときだけ内側 mw を呼ぶ', async () => {
    const inner = vi.fn<MiddlewareHandler<AppEnv>>(async (_c, next) => {
      await next();
    });
    const app = new Hono<AppEnv>();
    app.use(restrictToMethods(['POST'], inner));
    app.get('/test', (c) => c.json({ method: c.req.method }));
    app.post('/test', (c) => c.json({ method: c.req.method }));

    await app.request('/test', { method: 'GET' });
    expect(inner).not.toHaveBeenCalled();

    await app.request('/test', { method: 'POST' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('指定 method 外なら limiter を呼ばずに素通しする（rate-limit と組み合わせ）', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) } satisfies RateLimiter;
    const inner = createRateLimitMiddleware({
      limiter,
      retryAfterSec: 10,
      resolveKey: ipKey,
    });

    const app = new Hono<AppEnv>();
    app.use(restrictToMethods(['POST'], inner));
    app.get('/test', (c) => c.json({ ok: true }));
    app.post('/test', (c) => c.json({ ok: true }));
    app.onError(createErrorHandler(createSilentLogger()));

    // GET は restrictToMethods で素通り → limiter 呼ばれず 200
    const getRes = await app.request('/test', { method: 'GET' });
    expect(getRes.status).toBe(200);
    expect(limiter.limit).not.toHaveBeenCalled();

    // POST は limiter 呼ばれ、success=false なので 429
    const postRes = await app.request('/test', { method: 'POST' });
    expect(postRes.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledTimes(1);
  });
});
