import { describe, it, expect } from 'vitest';
import { MAX_ATTEMPTS, nextRetryDelayMs, WebhookDelivery } from './webhook-delivery';
import type { WebhookEvent } from '@/shared/domain/webhook-event';

// ---------------------------------------------------------------------------
// 指数バックオフ / dead 化判定の純関数テスト
// ---------------------------------------------------------------------------

describe('nextRetryDelayMs', () => {
  it('1 回失敗後は 1 分後', () => {
    expect(nextRetryDelayMs(1)).toBe(60 * 1000);
  });

  it('2 回失敗後は 5 分後', () => {
    expect(nextRetryDelayMs(2)).toBe(5 * 60 * 1000);
  });

  it('3 回失敗後は 30 分後', () => {
    expect(nextRetryDelayMs(3)).toBe(30 * 60 * 1000);
  });

  it('4 回失敗後は 4 時間後', () => {
    expect(nextRetryDelayMs(4)).toBe(4 * 60 * 60 * 1000);
  });

  it('5 回失敗後は 24 時間後（最後の retry）', () => {
    expect(nextRetryDelayMs(5)).toBe(24 * 60 * 60 * 1000);
  });

  it('6 回失敗後（= MAX_ATTEMPTS 到達）は null = dead', () => {
    expect(nextRetryDelayMs(MAX_ATTEMPTS)).toBeNull();
  });

  it('MAX_ATTEMPTS 超過も null（防御的）', () => {
    expect(nextRetryDelayMs(MAX_ATTEMPTS + 1)).toBeNull();
    expect(nextRetryDelayMs(99)).toBeNull();
  });

  it('遅延は単調増加（後ろほど長く待つ）', () => {
    const a = nextRetryDelayMs(1);
    const b = nextRetryDelayMs(2);
    const c = nextRetryDelayMs(3);
    const d = nextRetryDelayMs(4);
    const e = nextRetryDelayMs(5);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(d).not.toBeNull();
    expect(e).not.toBeNull();
    if (a !== null && b !== null && c !== null && d !== null && e !== null) {
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      expect(c).toBeLessThan(d);
      expect(d).toBeLessThan(e);
    }
  });
});

describe('WebhookDelivery.reconstruct', () => {
  const evt: WebhookEvent = {
    event_id: 'evt-1',
    event_type: 'order.placed',
    occurred_at: '2026-05-26T00:00:00.000Z',
    data: {
      order_id: 'ord-1',
      customer_id: 'cus-1',
      items: [{ cake_id: 'cake-1', quantity: 1, unit_price: 500 }],
      total_amount: 500,
    },
  };

  it('全フィールドをそのまま保持する（信頼境界の中なので再検証なし）', () => {
    const d = WebhookDelivery.reconstruct({
      id: 'd-1',
      eventId: evt.event_id,
      subscriptionId: 'sub-1',
      eventType: evt.event_type,
      payload: evt,
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRetryAt: new Date('2026-05-26T01:00:00.000Z'),
      succeededAt: null,
      createdAt: new Date('2026-05-26T00:00:00.000Z'),
    });
    expect(d.id).toBe('d-1');
    expect(d.subscriptionId).toBe('sub-1');
    expect(d.status).toBe('pending');
    expect(d.attempts).toBe(0);
    expect(d.payload).toBe(evt);
  });
});
