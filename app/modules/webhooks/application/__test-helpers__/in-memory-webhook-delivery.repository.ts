import { WebhookDelivery, type WebhookDeliveryStatus } from '../../domain/webhook-delivery';
import type {
  DueDelivery,
  EnqueueDeliveryInput,
  ListDeliveriesBySubscriptionParams,
  ListDueDeliveriesParams,
  MarkFailedInput,
  WebhookDeliveryPage,
  WebhookDeliveryRepository,
} from '../../domain/webhook-delivery.repository';

// ---------------------------------------------------------------------------
// テスト専用のメモリ実装。
//
//   subscription の url/secret は listDue で必要なので、本実装にも併設する
//   （Order の in-memory repo が cakes を併設しているのと同じ発想）。
//   テストの「全部メモリで動く」性質を活かす。
// ---------------------------------------------------------------------------

interface StoredDelivery {
  delivery: WebhookDelivery;
}

// internal: mutable shape を扱うため、reconstruct で作り直すヘルパ。
const rebuild = (
  prev: WebhookDelivery,
  updates: Partial<{
    status: WebhookDeliveryStatus;
    attempts: number;
    lastError: string | null;
    nextRetryAt: Date | null;
    succeededAt: Date | null;
  }>,
): WebhookDelivery =>
  WebhookDelivery.reconstruct({
    id: prev.id,
    eventId: prev.eventId,
    subscriptionId: prev.subscriptionId,
    eventType: prev.eventType,
    payload: prev.payload,
    status: updates.status ?? prev.status,
    attempts: updates.attempts ?? prev.attempts,
    lastError: updates.lastError !== undefined ? updates.lastError : prev.lastError,
    nextRetryAt: updates.nextRetryAt !== undefined ? updates.nextRetryAt : prev.nextRetryAt,
    succeededAt: updates.succeededAt !== undefined ? updates.succeededAt : prev.succeededAt,
    createdAt: prev.createdAt,
  });

const compareDesc = (a: WebhookDelivery, b: WebhookDelivery): number => {
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return bt - at;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

export class InMemoryWebhookDeliveryRepository implements WebhookDeliveryRepository {
  private readonly store = new Map<string, StoredDelivery>();
  // listDue の join 相当: subscription_id → { url, secret }
  private readonly subs = new Map<string, { url: string; secret: string }>();
  private idCounter = 0;

  // テスト用 helper: subscription の配信先情報を登録する。
  // 実 DB では webhook_subscriptions テーブルに JOIN で繋がる情報。
  seedSubscription(subscriptionId: string, url: string, secret: string): void {
    this.subs.set(subscriptionId, { url, secret });
  }

  // テスト用 helper: subscription を消す（cascade delete のシミュレーション）。
  removeSubscription(subscriptionId: string): void {
    this.subs.delete(subscriptionId);
    // 紐づく delivery 行も削除する（cascade delete の挙動）。
    for (const [id, s] of this.store.entries()) {
      if (s.delivery.subscriptionId === subscriptionId) {
        this.store.delete(id);
      }
    }
  }

  async enqueue(input: EnqueueDeliveryInput): Promise<WebhookDelivery | null> {
    // UNIQUE(event_id, subscription_id) の挙動を模す。
    for (const s of this.store.values()) {
      if (
        s.delivery.eventId === input.event.event_id &&
        s.delivery.subscriptionId === input.subscriptionId
      ) {
        return null;
      }
    }
    this.idCounter += 1;
    const id = `dddddddd-dddd-4ddd-8ddd-${String(this.idCounter).padStart(12, '0')}`;
    const delivery = WebhookDelivery.reconstruct({
      id,
      eventId: input.event.event_id,
      subscriptionId: input.subscriptionId,
      eventType: input.event.event_type,
      payload: input.event,
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRetryAt: new Date(),
      succeededAt: null,
      createdAt: new Date(),
    });
    this.store.set(id, { delivery });
    return delivery;
  }

  async listDue(params: ListDueDeliveriesParams): Promise<DueDelivery[]> {
    const due: DueDelivery[] = [];
    const candidates = [...this.store.values()]
      .map((s) => s.delivery)
      .filter(
        (d) =>
          (d.status === 'pending' || d.status === 'failed') &&
          d.nextRetryAt !== null &&
          d.nextRetryAt.getTime() <= params.now.getTime(),
      )
      .sort((a, b) => {
        // next_retry_at ASC, id ASC（古い順から拾う）
        const at = a.nextRetryAt?.getTime() ?? 0;
        const bt = b.nextRetryAt?.getTime() ?? 0;
        if (at !== bt) return at - bt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, params.limit);
    for (const d of candidates) {
      const target = this.subs.get(d.subscriptionId);
      if (!target) continue; // subscription が消えていれば skip
      due.push({ delivery: d, url: target.url, secret: target.secret });
    }
    return due;
  }

  async markSucceeded(deliveryId: string, succeededAt: Date): Promise<void> {
    const s = this.store.get(deliveryId);
    if (!s) return;
    this.store.set(deliveryId, {
      delivery: rebuild(s.delivery, {
        status: 'succeeded',
        succeededAt,
        nextRetryAt: null,
        lastError: null,
      }),
    });
  }

  async markFailed(deliveryId: string, input: MarkFailedInput): Promise<void> {
    const s = this.store.get(deliveryId);
    if (!s) return;
    const newAttempts = s.delivery.attempts + 1;
    const newStatus: WebhookDeliveryStatus = input.nextRetryAt === null ? 'dead' : 'failed';
    this.store.set(deliveryId, {
      delivery: rebuild(s.delivery, {
        status: newStatus,
        attempts: newAttempts,
        lastError: input.errorMessage,
        nextRetryAt: input.nextRetryAt,
      }),
    });
  }

  async listBySubscription(
    params: ListDeliveriesBySubscriptionParams,
  ): Promise<WebhookDeliveryPage> {
    const all = [...this.store.values()]
      .map((s) => s.delivery)
      .filter((d) => d.subscriptionId === params.subscriptionId)
      .sort(compareDesc);
    const filtered = params.after
      ? all.filter((d) => {
          const ca = d.createdAt.toISOString();
          if (ca !== params.after?.createdAt) return ca < (params.after?.createdAt ?? '');
          return d.id < (params.after?.id ?? '');
        })
      : all;
    const hasMore = filtered.length > params.limit;
    const deliveries = filtered.slice(0, params.limit);
    const last = deliveries[deliveries.length - 1];
    const nextCursor =
      hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null;
    return { deliveries, nextCursor };
  }

  // テスト用: 全件覗き
  all(): WebhookDelivery[] {
    return [...this.store.values()].map((s) => s.delivery);
  }
}
