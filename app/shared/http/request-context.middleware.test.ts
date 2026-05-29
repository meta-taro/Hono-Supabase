import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createRequestContextMiddleware } from '@/shared/http/request-context.middleware';
import type { AppEnv } from '@/shared/http/request-context';
import type { AppLogger } from '@/shared/infrastructure/logger';

// テスト用の最小ロガー: child() で呼ばれた bindings を spy で覗ける構造にする。
// 実装は AppLogger interface を満たすことだけ要件にして、本物の pino/console 実装は使わない。
const createSpyLogger = () => {
  const childCalls: Array<Record<string, unknown>> = [];
  const childLogger: AppLogger = {
    level: 'info',
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => childLogger),
  };
  const baseLogger: AppLogger = {
    level: 'info',
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn((bindings: Record<string, unknown>) => {
      childCalls.push(bindings);
      return childLogger;
    }),
  };
  return { baseLogger, childLogger, childCalls };
};

// requestId / logger を観測できる /probe エンドポイントを生やしたテスト用アプリ。
const buildApp = (params: { baseLogger: AppLogger; generateId?: () => string }) => {
  const app = new Hono<AppEnv>();
  app.use(
    '*',
    createRequestContextMiddleware({
      baseLogger: params.baseLogger,
      generateId: params.generateId,
    }),
  );
  app.get('/probe', (c) =>
    c.json({
      requestId: c.get('requestId'),
      hasLogger: c.get('logger') !== undefined,
    }),
  );
  return app;
};

describe('requestContextMiddleware', () => {
  it('X-Request-Id ヘッダが妥当ならそれを採用してレスポンスヘッダに反射する', async () => {
    const { baseLogger, childCalls } = createSpyLogger();
    const app = buildApp({ baseLogger, generateId: () => 'must-not-be-used' });

    const res = await app.request('/probe', {
      headers: { 'X-Request-Id': 'abc-123_XYZ' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBe('abc-123_XYZ');
    const body = (await res.json()) as { requestId: string; hasLogger: boolean };
    expect(body.requestId).toBe('abc-123_XYZ');
    expect(body.hasLogger).toBe(true);
    expect(childCalls).toEqual([{ requestId: 'abc-123_XYZ', method: 'GET', path: '/probe' }]);
  });

  it('X-Request-Id ヘッダが無ければ generateId() で自前生成する', async () => {
    const { baseLogger, childCalls } = createSpyLogger();
    const app = buildApp({ baseLogger, generateId: () => 'generated-uuid' });

    const res = await app.request('/probe');

    expect(res.headers.get('X-Request-Id')).toBe('generated-uuid');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe('generated-uuid');
    expect(childCalls[0]?.requestId).toBe('generated-uuid');
  });

  it('X-Request-Id ヘッダが空白だけなら無効扱いで自前生成する', async () => {
    const { baseLogger } = createSpyLogger();
    const app = buildApp({ baseLogger, generateId: () => 'gen-empty' });

    const res = await app.request('/probe', { headers: { 'X-Request-Id': '   ' } });

    expect(res.headers.get('X-Request-Id')).toBe('gen-empty');
  });

  it('X-Request-Id ヘッダに不許可文字（スラッシュ）が含まれれば無効扱い', async () => {
    const { baseLogger } = createSpyLogger();
    const app = buildApp({ baseLogger, generateId: () => 'gen-slash' });

    const res = await app.request('/probe', {
      headers: { 'X-Request-Id': 'evil/../traversal' },
    });

    expect(res.headers.get('X-Request-Id')).toBe('gen-slash');
  });

  it('X-Request-Id ヘッダが 128 文字を超えれば無効扱い', async () => {
    const { baseLogger } = createSpyLogger();
    const tooLong = 'a'.repeat(129);
    const app = buildApp({ baseLogger, generateId: () => 'gen-too-long' });

    const res = await app.request('/probe', {
      headers: { 'X-Request-Id': tooLong },
    });

    expect(res.headers.get('X-Request-Id')).toBe('gen-too-long');
  });

  it('child bindings に method / path / requestId が乗る', async () => {
    const { baseLogger, childCalls } = createSpyLogger();
    const app = buildApp({ baseLogger, generateId: () => 'rid-1' });
    app.post('/v1/items', (c) => c.json({ ok: true }));

    await app.request('/v1/items', { method: 'POST' });

    // /probe は GET 用に作ってあるので、ここは追加した /v1/items の child binding を見る。
    const lastCall = childCalls[childCalls.length - 1];
    expect(lastCall).toEqual({ requestId: 'rid-1', method: 'POST', path: '/v1/items' });
  });

  it('generateId を省略するとデフォルトで crypto.randomUUID() を使う', async () => {
    const { baseLogger } = createSpyLogger();
    const app = buildApp({ baseLogger });

    const res = await app.request('/probe');
    const reflected = res.headers.get('X-Request-Id');

    // UUID v4 形式（xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx）に合致することだけ確認。
    expect(reflected).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
