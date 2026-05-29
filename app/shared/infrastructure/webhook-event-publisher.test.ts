import { describe, it, expect } from 'vitest';
import { createWebhookEventPublisher } from './webhook-event-publisher';
import { createSilentLogger } from './logger';
import type { WebhookEvent } from '@/shared/domain/webhook-event';
import type {
  CreateWebhookSubscriptionInput,
  WebhookSubscriptionRepository,
  ListWebhookSubscriptionsParams,
  WebhookSubscriptionPage,
} from '@/modules/webhooks/domain/webhook-subscription.repository';
import { WebhookSubscription } from '@/modules/webhooks/domain/webhook-subscription';
import type {
  EnqueueDeliveryInput,
  WebhookDeliveryRepository,
  ListDueDeliveriesParams,
  ListDeliveriesBySubscriptionParams,
  WebhookDeliveryPage,
  DueDelivery,
  MarkFailedInput,
} from '@/modules/webhooks/domain/webhook-delivery.repository';
import type { WebhookDelivery } from '@/modules/webhooks/domain/webhook-delivery';

// ---------------------------------------------------------------------------
// WebhookEventPublisher のユニットテスト
//   - subscription が 0 件なら no-op
//   - 複数 sub があれば全件 enqueue
//   - 1 件 enqueue が throw しても他は継続（部分失敗を許容）
//   - subscriptionRepo.listForPublish 失敗時は warn ログのみで throw しない（主系を守る）
// ---------------------------------------------------------------------------

const EVENT: WebhookEvent = {
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

const VALID_SECRET = 'a'.repeat(64);

const makeSub = (id: string): WebhookSubscription =>
  WebhookSubscription.create({ id, url: `https://example.com/${id}`, secret: VALID_SECRET });

class FakeSubRepo implements WebhookSubscriptionRepository {
  constructor(
    private readonly subs: WebhookSubscription[],
    private readonly opts?: { throwOnList?: boolean },
  ) {}
  async create(_input: CreateWebhookSubscriptionInput): Promise<WebhookSubscription> {
    throw new Error('not used');
  }
  async findById(_id: string): Promise<WebhookSubscription | null> {
    return null;
  }
  async list(_params: ListWebhookSubscriptionsParams): Promise<WebhookSubscriptionPage> {
    return { subscriptions: [], nextCursor: null };
  }
  async listForPublish(): Promise<WebhookSubscription[]> {
    if (this.opts?.throwOnList) throw new Error('boom');
    return this.subs;
  }
  async delete(_id: string): Promise<boolean> {
    return false;
  }
}

class FakeDeliveryRepo implements WebhookDeliveryRepository {
  readonly enqueueCalls: EnqueueDeliveryInput[] = [];
  constructor(private readonly opts?: { throwOnIds?: Set<string> }) {}
  async enqueue(input: EnqueueDeliveryInput): Promise<WebhookDelivery | null> {
    this.enqueueCalls.push(input);
    if (this.opts?.throwOnIds?.has(input.subscriptionId)) throw new Error('insert failed');
    return null;
  }
  async listDue(_params: ListDueDeliveriesParams): Promise<DueDelivery[]> {
    return [];
  }
  async markSucceeded(_id: string, _at: Date): Promise<void> {}
  async markFailed(_id: string, _input: MarkFailedInput): Promise<void> {}
  async listBySubscription(
    _params: ListDeliveriesBySubscriptionParams,
  ): Promise<WebhookDeliveryPage> {
    return { deliveries: [], nextCursor: null };
  }
}

describe('createWebhookEventPublisher', () => {
  it('subscription 0 件なら enqueue を 1 回も呼ばない（no-op）', async () => {
    const subRepo = new FakeSubRepo([]);
    const delRepo = new FakeDeliveryRepo();
    const pub = createWebhookEventPublisher({
      subscriptionRepo: subRepo,
      deliveryRepo: delRepo,
      logger: createSilentLogger(),
    });
    await pub.publish(EVENT);
    expect(delRepo.enqueueCalls).toHaveLength(0);
  });

  it('subscription が 3 件あれば 3 回 enqueue を呼ぶ', async () => {
    const subRepo = new FakeSubRepo([makeSub('s1'), makeSub('s2'), makeSub('s3')]);
    const delRepo = new FakeDeliveryRepo();
    const pub = createWebhookEventPublisher({
      subscriptionRepo: subRepo,
      deliveryRepo: delRepo,
      logger: createSilentLogger(),
    });
    await pub.publish(EVENT);
    expect(delRepo.enqueueCalls.map((c) => c.subscriptionId)).toEqual(['s1', 's2', 's3']);
    for (const c of delRepo.enqueueCalls) {
      expect(c.event).toBe(EVENT);
    }
  });

  it('1 件の enqueue が throw しても他 sub への enqueue は続行する', async () => {
    const subRepo = new FakeSubRepo([makeSub('s1'), makeSub('s2'), makeSub('s3')]);
    const delRepo = new FakeDeliveryRepo({ throwOnIds: new Set(['s2']) });
    const pub = createWebhookEventPublisher({
      subscriptionRepo: subRepo,
      deliveryRepo: delRepo,
      logger: createSilentLogger(),
    });
    await expect(pub.publish(EVENT)).resolves.toBeUndefined();
    // 3 件すべて enqueue 試行されている（s2 だけ throw、他は記録される）
    expect(delRepo.enqueueCalls.map((c) => c.subscriptionId)).toEqual(['s1', 's2', 's3']);
  });

  it('subscriptionRepo.listForPublish が throw しても publish は throw せず警告ログだけ残す（主系を守る）', async () => {
    const subRepo = new FakeSubRepo([], { throwOnList: true });
    const delRepo = new FakeDeliveryRepo();
    const pub = createWebhookEventPublisher({
      subscriptionRepo: subRepo,
      deliveryRepo: delRepo,
      logger: createSilentLogger(),
    });
    await expect(pub.publish(EVENT)).resolves.toBeUndefined();
    expect(delRepo.enqueueCalls).toHaveLength(0);
  });
});
