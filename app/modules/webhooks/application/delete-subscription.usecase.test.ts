import { describe, it, expect } from 'vitest';
import { createDeleteSubscriptionUseCase } from './delete-subscription.usecase';
import { InMemoryWebhookSubscriptionRepository } from './__test-helpers__/in-memory-webhook-subscription.repository';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { NotFoundError } from '@/shared/domain/errors';

const VALID_SECRET = 'a'.repeat(64);

describe('DeleteSubscriptionUseCase', () => {
  it('存在する id を削除すると repo から消える', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    const created = await repo.create({ url: 'https://example.com', secret: VALID_SECRET });
    const uc = createDeleteSubscriptionUseCase(repo, createSilentLogger());
    await uc({ id: created.id });
    expect(repo.size()).toBe(0);
  });

  it('未存在の id は NotFoundError(404) を投げる', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    const uc = createDeleteSubscriptionUseCase(repo, createSilentLogger());
    await expect(uc({ id: 'missing-id' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
