import { describe, it, expect } from 'vitest';
import { dispatchPendingDeliveries } from './dispatch-pending-deliveries';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { InMemoryWebhookDeliveryRepository } from '@/modules/webhooks/application/__test-helpers__/in-memory-webhook-delivery.repository';
import type { WebhookEvent } from '@/shared/domain/webhook-event';
import type {
  DispatchResult,
  DispatchTarget,
  WebhookDispatcher,
} from '@/shared/application/webhook-dispatcher';
import { MAX_ATTEMPTS } from '@/modules/webhooks/domain/webhook-delivery';

// ---------------------------------------------------------------------------
// dispatchPendingDeliveries の振る舞いテスト
//   in-memory repo + fake dispatcher で 1 ラウンドの遷移を観察する。
//   - 成功は succeeded に遷移、attempts は変えない（実装の規約）
//   - 失敗は failed + next_retry_at = now + delay にスケジュール
//   - MAX_ATTEMPTS 到達時は dead（next_retry_at = null）
// ---------------------------------------------------------------------------

const EVENT_BASE = (id: string): WebhookEvent => ({
  event_id: id,
  event_type: 'order.placed',
  occurred_at: '2026-05-26T00:00:00.000Z',
  data: {
    order_id: 'ord-1',
    customer_id: 'cus-1',
    items: [{ cake_id: 'cake-1', quantity: 1, unit_price: 500 }],
    total_amount: 500,
  },
});

const VALID_SECRET = 'a'.repeat(64);

// in-memory repo.enqueue は wall clock の new Date() で nextRetryAt を入れるため、
// NOW は「enqueue 直後の wall clock より後ろ」になる必要がある（さもないと listDue から外れる）。
// テストごとに dispatch 呼び出しの直前に確定させる。
const makeRepoWithOne = async (
  subId: string,
): Promise<{ repo: InMemoryWebhookDeliveryRepository; now: Date }> => {
  const repo = new InMemoryWebhookDeliveryRepository();
  repo.seedSubscription(subId, 'https://example.com/hook', VALID_SECRET);
  await repo.enqueue({ event: EVENT_BASE('evt-1'), subscriptionId: subId });
  const now = new Date(Date.now() + 60_000);
  return { repo, now };
};

class FakeDispatcher implements WebhookDispatcher {
  constructor(private readonly result: DispatchResult) {}
  async deliver(_event: WebhookEvent, _target: DispatchTarget): Promise<DispatchResult> {
    return this.result;
  }
}

describe('dispatchPendingDeliveries', () => {
  it('成功時は status=succeeded に遷移、succeeded カウントが増える', async () => {
    const { repo, now } = await makeRepoWithOne('sub-1');
    const dispatcher = new FakeDispatcher({ kind: 'succeeded' });
    const summary = await dispatchPendingDeliveries({
      deliveryRepo: repo,
      dispatcher,
      logger: createSilentLogger(),
      now: () => now,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0, dead: 0 });
    const all = repo.all();
    expect(all).toHaveLength(1);
    const d = all[0]!;
    expect(d.status).toBe('succeeded');
    expect(d.succeededAt?.toISOString()).toBe(now.toISOString());
    expect(d.nextRetryAt).toBeNull();
  });

  it('1 回目の失敗で status=failed・attempts=1・next_retry_at = now+1 分', async () => {
    const { repo, now } = await makeRepoWithOne('sub-1');
    const dispatcher = new FakeDispatcher({ kind: 'failed', message: 'HTTP 500' });
    const summary = await dispatchPendingDeliveries({
      deliveryRepo: repo,
      dispatcher,
      logger: createSilentLogger(),
      now: () => now,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1, dead: 0 });
    const d = repo.all()[0]!;
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(1);
    expect(d.lastError).toBe('HTTP 500');
    expect(d.nextRetryAt?.getTime()).toBe(now.getTime() + 60 * 1000);
  });

  it('subscription が消えていれば listDue から除外される（cascade 削除のシミュレーション）', async () => {
    const { repo, now } = await makeRepoWithOne('sub-1');
    repo.removeSubscription('sub-1');
    const dispatcher = new FakeDispatcher({ kind: 'succeeded' });
    const summary = await dispatchPendingDeliveries({
      deliveryRepo: repo,
      dispatcher,
      logger: createSilentLogger(),
      now: () => now,
    });
    expect(summary.attempted).toBe(0);
  });

  it('limit より多い due があってもその件数だけ処理する', async () => {
    const repo = new InMemoryWebhookDeliveryRepository();
    repo.seedSubscription('sub-1', 'https://example.com/hook', VALID_SECRET);
    for (let i = 0; i < 7; i += 1) {
      await repo.enqueue({ event: EVENT_BASE(`evt-${String(i)}`), subscriptionId: 'sub-1' });
    }
    const now = new Date(Date.now() + 60_000);
    const dispatcher = new FakeDispatcher({ kind: 'succeeded' });
    const summary = await dispatchPendingDeliveries({
      deliveryRepo: repo,
      dispatcher,
      logger: createSilentLogger(),
      now: () => now,
      limit: 3,
    });
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(3);
    // 残り 4 件は次ラウンドで拾われる想定（status は pending のまま）
    const remaining = repo.all().filter((d) => d.status === 'pending');
    expect(remaining).toHaveLength(4);
  });

  it('attempts が MAX_ATTEMPTS-1 の状態から 1 ラウンド失敗すると dead 化（next_retry_at=null）', async () => {
    // 直接 markFailed を 5 回呼んで attempts=5 / status=failed / next_retry_at=now に到達させる
    const { repo, now } = await makeRepoWithOne('sub-1');
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      const d = repo.all()[0]!;
      await repo.markFailed(d.id, { errorMessage: 'preload', nextRetryAt: now });
    }
    expect(repo.all()[0]!.attempts).toBe(MAX_ATTEMPTS - 1);
    expect(repo.all()[0]!.status).toBe('failed');

    const dispatcher = new FakeDispatcher({ kind: 'failed', message: 'final' });
    const summary = await dispatchPendingDeliveries({
      deliveryRepo: repo,
      dispatcher,
      logger: createSilentLogger(),
      now: () => now,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 0, dead: 1 });
    const final = repo.all()[0]!;
    expect(final.status).toBe('dead');
    expect(final.attempts).toBe(MAX_ATTEMPTS);
    expect(final.nextRetryAt).toBeNull();
    expect(final.lastError).toBe('final');
  });
});
