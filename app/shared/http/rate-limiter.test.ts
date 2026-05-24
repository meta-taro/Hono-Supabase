import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './rate-limiter';

describe('InMemoryRateLimiter', () => {
  it('limit 未満は success: true、超過した瞬間に success: false を返す', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 3, periodSec: 10, now: () => 1000 });

    expect((await limiter.limit({ key: 'k' })).success).toBe(true);
    expect((await limiter.limit({ key: 'k' })).success).toBe(true);
    expect((await limiter.limit({ key: 'k' })).success).toBe(true);
    expect((await limiter.limit({ key: 'k' })).success).toBe(false);
  });

  it('ウィンドウ越えで count がリセットされる', async () => {
    let nowMs = 1000;
    const limiter = new InMemoryRateLimiter({ limit: 2, periodSec: 10, now: () => nowMs });

    await limiter.limit({ key: 'k' });
    await limiter.limit({ key: 'k' });
    expect((await limiter.limit({ key: 'k' })).success).toBe(false);

    // period（10s）ちょうど経過させてウィンドウを越える。
    nowMs = 1000 + 10_000;
    expect((await limiter.limit({ key: 'k' })).success).toBe(true);
  });

  it('別 key は独立してカウントされる', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, periodSec: 10, now: () => 1000 });

    expect((await limiter.limit({ key: 'a' })).success).toBe(true);
    expect((await limiter.limit({ key: 'a' })).success).toBe(false);
    expect((await limiter.limit({ key: 'b' })).success).toBe(true);
  });

  it('limit=0 は最初の 1 回でも拒否する', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 0, periodSec: 10, now: () => 1000 });
    expect((await limiter.limit({ key: 'k' })).success).toBe(false);
  });

  it('ウィンドウ未満（period 直前）はまだリセットされない', async () => {
    let nowMs = 1000;
    const limiter = new InMemoryRateLimiter({ limit: 1, periodSec: 10, now: () => nowMs });

    await limiter.limit({ key: 'k' });
    nowMs = 1000 + 9_999; // 10s - 1ms
    expect((await limiter.limit({ key: 'k' })).success).toBe(false);
  });
});
