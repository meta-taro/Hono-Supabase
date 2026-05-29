import { describe, it, expect } from 'vitest';
import { createApp, type HealthDbProbe } from '@/app';

interface HealthBody {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  db?: { ok: boolean; latency_ms: number };
}

const fakeProbe = (result: { ok: boolean; latency_ms: number }): HealthDbProbe => {
  return async () => result;
};

describe('GET /health', () => {
  it('probe 省略時は 200 と { status: "ok", version } のみ（最小互換）', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({ status: 'ok', version: 'local' });
  });

  it('appVersion を渡すと /health の version に反映される', async () => {
    const app = createApp({
      rootMiddlewares: [],
      guards: { adminGuard: [], authGuard: [] },
      appVersion: 'v-test-123',
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({ status: 'ok', version: 'v-test-123' });
  });

  // Phase 9 Step 3a: probe あり → 3 状態 + db フィールド付き

  it('probe ok かつ latency ≤ 800 → status:"ok" / HTTP 200 / db フィールド付き', async () => {
    const app = createApp({
      rootMiddlewares: [],
      guards: { adminGuard: [], authGuard: [] },
      appVersion: 'v-probe',
      healthDbProbe: fakeProbe({ ok: true, latency_ms: 120 }),
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({
      status: 'ok',
      version: 'v-probe',
      db: { ok: true, latency_ms: 120 },
    });
  });

  it('probe ok だが latency > 800 → status:"degraded" / HTTP 200', async () => {
    const app = createApp({
      rootMiddlewares: [],
      guards: { adminGuard: [], authGuard: [] },
      appVersion: 'v-probe',
      healthDbProbe: fakeProbe({ ok: true, latency_ms: 950 }),
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({
      status: 'degraded',
      version: 'v-probe',
      db: { ok: true, latency_ms: 950 },
    });
  });

  it('probe ok:false（タイムアウト相当）→ status:"down" / HTTP 503', async () => {
    const app = createApp({
      rootMiddlewares: [],
      guards: { adminGuard: [], authGuard: [] },
      appVersion: 'v-probe',
      healthDbProbe: fakeProbe({ ok: false, latency_ms: 1500 }),
    });
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({
      status: 'down',
      version: 'v-probe',
      db: { ok: false, latency_ms: 1500 },
    });
  });

  it('probe ok:false（クエリエラー相当・低 latency）→ status:"down" / HTTP 503', async () => {
    const app = createApp({
      rootMiddlewares: [],
      guards: { adminGuard: [], authGuard: [] },
      appVersion: 'v-probe',
      healthDbProbe: fakeProbe({ ok: false, latency_ms: 35 }),
    });
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({
      status: 'down',
      version: 'v-probe',
      db: { ok: false, latency_ms: 35 },
    });
  });
});
