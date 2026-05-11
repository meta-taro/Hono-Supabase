import { describe, it, expect } from 'vitest';
import { createApp } from '@/app';

describe('GET /health', () => {
  it('200 と { status: "ok", version } を返す（version 省略時は "local"）', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
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
    const body = (await res.json()) as { status: string; version: string };
    expect(body).toEqual({ status: 'ok', version: 'v-test-123' });
  });
});
