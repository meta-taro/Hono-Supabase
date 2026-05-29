import { describe, it, expect } from 'vitest';
import { createListSubscriptionsUseCase } from './list-subscriptions.usecase';
import { InMemoryWebhookSubscriptionRepository } from './__test-helpers__/in-memory-webhook-subscription.repository';
import { WebhookSubscription } from '../domain/webhook-subscription';

const VALID_SECRET = 'a'.repeat(64);

const makeAt = (id: string, isoCreatedAt: string): WebhookSubscription =>
  WebhookSubscription.create({
    id,
    url: `https://example.com/${id}`,
    secret: VALID_SECRET,
    createdAt: new Date(isoCreatedAt),
    updatedAt: new Date(isoCreatedAt),
  });

describe('ListSubscriptionsUseCase', () => {
  it('created_at DESC で並ぶ', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    repo.seed(makeAt('00000000-0000-4000-8000-000000000001', '2026-05-26T00:00:00.000Z'));
    repo.seed(makeAt('00000000-0000-4000-8000-000000000002', '2026-05-26T01:00:00.000Z'));
    repo.seed(makeAt('00000000-0000-4000-8000-000000000003', '2026-05-26T02:00:00.000Z'));
    const uc = createListSubscriptionsUseCase(repo);
    const res = await uc({ limit: 10 });
    expect(res.subscriptions.map((s) => s.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(res.nextCursor).toBeNull();
  });

  it('limit を超えると nextCursor が返り、after で続きを取得できる', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    repo.seed(makeAt('00000000-0000-4000-8000-000000000001', '2026-05-26T00:00:00.000Z'));
    repo.seed(makeAt('00000000-0000-4000-8000-000000000002', '2026-05-26T01:00:00.000Z'));
    repo.seed(makeAt('00000000-0000-4000-8000-000000000003', '2026-05-26T02:00:00.000Z'));
    const uc = createListSubscriptionsUseCase(repo);
    const page1 = await uc({ limit: 2 });
    expect(page1.subscriptions.map((s) => s.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await uc({ limit: 2, after: page1.nextCursor ?? undefined });
    expect(page2.subscriptions.map((s) => s.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(page2.nextCursor).toBeNull();
  });
});
