import { describe, it, expect } from 'vitest';
import { createRegisterSubscriptionUseCase } from './register-subscription.usecase';
import { InMemoryWebhookSubscriptionRepository } from './__test-helpers__/in-memory-webhook-subscription.repository';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { ValidationError } from '@/shared/domain/errors';

const VALID_SECRET = 'a'.repeat(64);

describe('RegisterSubscriptionUseCase', () => {
  it('正しい URL + secret で subscription を作成して返す', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    const uc = createRegisterSubscriptionUseCase(repo, createSilentLogger());
    const sub = await uc({
      url: 'https://example.com/hook',
      secret: VALID_SECRET,
      description: 'test',
    });
    expect(sub.url).toBe('https://example.com/hook');
    expect(sub.secret).toBe(VALID_SECRET);
    expect(sub.description).toBe('test');
    expect(repo.size()).toBe(1);
  });

  it('URL が不正なら domain の WebhookSubscriptionInvalidError を ValidationError(400) に変換する', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    const uc = createRegisterSubscriptionUseCase(repo, createSilentLogger());
    await expect(uc({ url: 'ftp://bad', secret: VALID_SECRET })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('secret が短すぎても ValidationError に倒す', async () => {
    const repo = new InMemoryWebhookSubscriptionRepository();
    const uc = createRegisterSubscriptionUseCase(repo, createSilentLogger());
    await expect(uc({ url: 'https://example.com', secret: 'too-short' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
