import { describe, it, expect } from 'vitest';
import { buildWebhookSignatureHeader, generateWebhookSecret } from './webhook-signature';

// ---------------------------------------------------------------------------
// HMAC 署名 / secret 生成のユニットテスト
//   - 決定性（同じ入力 → 同じ署名）は受信側 verify の前提
//   - フォーマット（t=... ,v1=hex）が Stripe スタイル準拠であること
//   - generateWebhookSecret は subscription.secret の長さ制約 (32〜256) を満たす
// ---------------------------------------------------------------------------

describe('buildWebhookSignatureHeader', () => {
  it('同じ secret / body / timestamp なら毎回同じ署名を返す（決定性）', async () => {
    const a = await buildWebhookSignatureHeader({
      secret: 'whsec_abc',
      rawBody: '{"a":1}',
      timestampSec: 1_700_000_000,
    });
    const b = await buildWebhookSignatureHeader({
      secret: 'whsec_abc',
      rawBody: '{"a":1}',
      timestampSec: 1_700_000_000,
    });
    expect(a).toBe(b);
  });

  it('t=<unix>,v1=<64桁hex> の形式を返す', async () => {
    const sig = await buildWebhookSignatureHeader({
      secret: 'whsec_xyz',
      rawBody: '{}',
      timestampSec: 1_700_000_123,
    });
    expect(sig).toMatch(/^t=1700000123,v1=[0-9a-f]{64}$/);
  });

  it('rawBody が 1 文字でも違えば署名は変わる', async () => {
    const a = await buildWebhookSignatureHeader({
      secret: 'whsec_abc',
      rawBody: '{"a":1}',
      timestampSec: 1_700_000_000,
    });
    const b = await buildWebhookSignatureHeader({
      secret: 'whsec_abc',
      rawBody: '{"a":2}',
      timestampSec: 1_700_000_000,
    });
    expect(a).not.toBe(b);
  });

  it('secret が違えば署名は変わる', async () => {
    const a = await buildWebhookSignatureHeader({
      secret: 'whsec_aaa',
      rawBody: '{}',
      timestampSec: 1_700_000_000,
    });
    const b = await buildWebhookSignatureHeader({
      secret: 'whsec_bbb',
      rawBody: '{}',
      timestampSec: 1_700_000_000,
    });
    expect(a).not.toBe(b);
  });

  it('timestamp が違えば署名は変わる（replay 検知のため）', async () => {
    const a = await buildWebhookSignatureHeader({
      secret: 'whsec_abc',
      rawBody: '{}',
      timestampSec: 1_700_000_000,
    });
    const b = await buildWebhookSignatureHeader({
      secret: 'whsec_abc',
      rawBody: '{}',
      timestampSec: 1_700_000_001,
    });
    expect(a).not.toBe(b);
  });
});

describe('generateWebhookSecret', () => {
  it('64 文字の hex 文字列を返す（= 32 バイトのランダム値）', () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it('呼び出すたびに異なる値が返る（衝突確率は 2^256 で実質ゼロ）', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });

  it('subscription.secret の長さ制約 32〜256 文字を満たす', () => {
    const s = generateWebhookSecret();
    expect(s.length).toBeGreaterThanOrEqual(32);
    expect(s.length).toBeLessThanOrEqual(256);
  });
});
