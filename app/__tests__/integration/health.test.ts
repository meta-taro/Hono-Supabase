import { describe, it, expect } from 'vitest';
import { createApp } from '@/app';

describe('GET /health', () => {
  it('200 と { status: "ok" } を返す', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body).toEqual({ status: 'ok' });
  });
});
