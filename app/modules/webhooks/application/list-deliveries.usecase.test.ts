import { describe, it, expect } from 'vitest';
import { createListDeliveriesUseCase } from './list-deliveries.usecase';
import { InMemoryWebhookSubscriptionRepository } from './__test-helpers__/in-memory-webhook-subscription.repository';
import { InMemoryWebhookDeliveryRepository } from './__test-helpers__/in-memory-webhook-delivery.repository';
import { NotFoundError } from '@/shared/domain/errors';
import type { WebhookEvent } from '@/shared/domain/webhook-event';

const VALID_SECRET = 'a'.repeat(64);

const evt = (id: string): WebhookEvent => ({
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

describe('ListDeliveriesUseCase', () => {
  it('subscription が存在しなければ NotFoundError(404)', async () => {
    const subRepo = new InMemoryWebhookSubscriptionRepository();
    const delRepo = new InMemoryWebhookDeliveryRepository();
    const uc = createListDeliveriesUseCase(subRepo, delRepo);
    await expect(uc({ subscriptionId: 'missing', limit: 10 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('subscription があれば deliveries を返す（created_at DESC）', async () => {
    const subRepo = new InMemoryWebhookSubscriptionRepository();
    const created = await subRepo.create({ url: 'https://example.com', secret: VALID_SECRET });
    const delRepo = new InMemoryWebhookDeliveryRepository();
    delRepo.seedSubscription(created.id, 'https://example.com', VALID_SECRET);
    await delRepo.enqueue({ event: evt('evt-1'), subscriptionId: created.id });
    await delRepo.enqueue({ event: evt('evt-2'), subscriptionId: created.id });
    const uc = createListDeliveriesUseCase(subRepo, delRepo);
    const res = await uc({ subscriptionId: created.id, limit: 10 });
    expect(res.deliveries).toHaveLength(2);
  });
});
