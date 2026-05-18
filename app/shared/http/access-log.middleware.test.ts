import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  createAccessLogMiddleware,
  type AccessLogMetricsBinding,
} from '@/shared/http/access-log.middleware';
import type { AppEnv, AuthUser } from '@/shared/http/request-context';
import type { AppLogger } from '@/shared/infrastructure/logger';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import type { MetricsRecorder, RequestMetricInput } from '@/shared/infrastructure/metrics';

// AppLogger interface を満たす spy ロガーを返す。
// 個別の mock fn をトップレベルで返すのは、`expect(logger.info)` 形式で参照すると
// ESLint の @typescript-eslint/unbound-method ルールに引っかかるため。
// `spy.info.toHaveBeenCalled()` のように個別変数経由で参照することで unbound にしない。
const createSpyLogger = () => {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const trace = vi.fn();
  const debug = vi.fn();
  const fatal = vi.fn();
  // child 自体は accessLog では呼ばれない（既に requestContext で child 済みのロガーが
  // c.var.logger に乗っている前提）。子ロガーが必要になる経路では本物の silent を返す。
  const child = vi.fn(() => createSilentLogger());
  const logger: AppLogger = { level: 'info', trace, debug, info, warn, error, fatal, child };
  return { logger, info, warn, error };
};

// テスト用最小アプリ:
//   - logger を必ず c.var に積む前段 middleware を入れる（accessLog の前提）
//   - 任意で user も積めるようにする
//   - ハンドラ側で status を変えてレベル別の出し分けを観察する
const buildApp = (params: { logger: AppLogger; user?: AuthUser }) => {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('logger', params.logger);
    if (params.user) c.set('user', params.user);
    await next();
  });
  app.use('*', createAccessLogMiddleware());
  app.get('/ok', (c) => c.json({ ok: true }));
  app.get('/not-found', (c) => c.json({ error: 'nf' }, 404));
  app.get('/boom', (c) => c.json({ error: 'boom' }, 500));
  return app;
};

describe('accessLogMiddleware', () => {
  beforeEach(() => {
    // duration_ms を決定論的に観測するため Date.now() を固定する。
    // 入口は 1000ms、出口は 1042ms を返すよう順次差し替え → 差分 42ms。
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? 1000 : 1042;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('2xx は info レベルで status / duration_ms を残す', async () => {
    const spy = createSpyLogger();
    const app = buildApp({ logger: spy.logger });

    const res = await app.request('/ok');

    expect(res.status).toBe(200);
    expect(spy.info).toHaveBeenCalledTimes(1);
    expect(spy.warn).not.toHaveBeenCalled();
    expect(spy.error).not.toHaveBeenCalled();
    expect(spy.info).toHaveBeenCalledWith({ status: 200, duration_ms: 42 }, 'request completed');
  });

  it('4xx は warn レベルで吐く', async () => {
    const spy = createSpyLogger();
    const app = buildApp({ logger: spy.logger });

    const res = await app.request('/not-found');

    expect(res.status).toBe(404);
    expect(spy.warn).toHaveBeenCalledTimes(1);
    expect(spy.info).not.toHaveBeenCalled();
    expect(spy.error).not.toHaveBeenCalled();
    expect(spy.warn).toHaveBeenCalledWith({ status: 404, duration_ms: 42 }, 'request completed');
  });

  it('5xx は error レベルで吐く', async () => {
    const spy = createSpyLogger();
    const app = buildApp({ logger: spy.logger });

    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    expect(spy.error).toHaveBeenCalledTimes(1);
    expect(spy.info).not.toHaveBeenCalled();
    expect(spy.warn).not.toHaveBeenCalled();
    expect(spy.error).toHaveBeenCalledWith({ status: 500, duration_ms: 42 }, 'request completed');
  });

  it('認証済みリクエストは bindings に userId が乗る', async () => {
    const spy = createSpyLogger();
    const user: AuthUser = { id: 'user-uuid-xyz', role: 'authenticated' };
    const app = buildApp({ logger: spy.logger, user });

    await app.request('/ok');

    expect(spy.info).toHaveBeenCalledWith(
      { status: 200, duration_ms: 42, userId: 'user-uuid-xyz' },
      'request completed',
    );
  });

  it('未認証リクエストでは userId キーごと省略される', async () => {
    const spy = createSpyLogger();
    const app = buildApp({ logger: spy.logger });

    await app.request('/ok');

    const firstCall = spy.info.mock.calls[0];
    const bindings = firstCall?.[0];
    expect(bindings).toEqual({ status: 200, duration_ms: 42 });
    expect(Object.keys(bindings as object)).not.toContain('userId');
  });

  it('logger が未セット（requestContext を入れていない経路）の場合は no-op', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', createAccessLogMiddleware());
    app.get('/ok', (c) => c.json({ ok: true }));

    // ここでは「ログが出ない」を検証するため、console をモニタリングする。
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const res = await app.request('/ok');

    expect(res.status).toBe(200);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Phase 9 Step 4: metrics 注入時のメトリクス書き込み検証
  // -------------------------------------------------------------------------

  const createSpyRecorder = () => {
    const recordRequest = vi.fn<(input: RequestMetricInput) => void>();
    const recorder: MetricsRecorder = { recordRequest };
    return { recorder, recordRequest };
  };

  const buildAppWithMetrics = (params: { logger: AppLogger; metrics: AccessLogMetricsBinding }) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('logger', params.logger);
      await next();
    });
    app.use('*', createAccessLogMiddleware({ metrics: params.metrics }));
    app.get('/ok', (c) => c.json({ ok: true }));
    // 動的セグメントを含むルートで routePath が正規化形（'/v1/orders/:id'）に
    // なることを確認するためのハンドラ。
    app.get('/v1/orders/:id', (c) => c.json({ id: c.req.param('id') }));
    app.get('/boom', (c) => c.json({ error: 'boom' }, 500));
    return app;
  };

  it('metrics 注入時は recordRequest が呼ばれる（method/route/status/duration_ms/env/app_version）', async () => {
    const spy = createSpyLogger();
    const m = createSpyRecorder();
    const app = buildAppWithMetrics({
      logger: spy.logger,
      metrics: { recorder: m.recorder, env: 'staging', app_version: 'v-123' },
    });

    await app.request('/ok');

    expect(m.recordRequest).toHaveBeenCalledTimes(1);
    expect(m.recordRequest).toHaveBeenCalledWith({
      method: 'GET',
      route: '/ok',
      status: 200,
      duration_ms: 42,
      env: 'staging',
      app_version: 'v-123',
    });
  });

  it('動的セグメントのルートは正規化形（/v1/orders/:id）として route に渡る', async () => {
    const spy = createSpyLogger();
    const m = createSpyRecorder();
    const app = buildAppWithMetrics({
      logger: spy.logger,
      metrics: { recorder: m.recorder, env: 'staging', app_version: 'v-123' },
    });

    await app.request('/v1/orders/abc-123');

    expect(m.recordRequest).toHaveBeenCalledTimes(1);
    const arg = m.recordRequest.mock.calls[0]?.[0];
    expect(arg?.route).toBe('/v1/orders/:id');
  });

  it('5xx でも metrics は呼ばれる（status はそのまま渡る）', async () => {
    const spy = createSpyLogger();
    const m = createSpyRecorder();
    const app = buildAppWithMetrics({
      logger: spy.logger,
      metrics: { recorder: m.recorder, env: 'production', app_version: 'v-zzz' },
    });

    await app.request('/boom');

    expect(m.recordRequest).toHaveBeenCalledTimes(1);
    const arg = m.recordRequest.mock.calls[0]?.[0];
    expect(arg?.status).toBe(500);
    expect(arg?.env).toBe('production');
  });

  it('metrics 未注入時は recordRequest を一切呼ばない（既存挙動と同じ）', async () => {
    const spy = createSpyLogger();
    const m = createSpyRecorder();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('logger', spy.logger);
      await next();
    });
    // metrics 引数を省略 → no-op 経路
    app.use('*', createAccessLogMiddleware());
    app.get('/ok', (c) => c.json({ ok: true }));

    await app.request('/ok');

    expect(spy.info).toHaveBeenCalledTimes(1);
    expect(m.recordRequest).not.toHaveBeenCalled();
  });
});
