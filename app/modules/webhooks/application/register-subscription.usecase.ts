import type { AppLogger } from '@/shared/infrastructure/logger';
import {
  WebhookSubscription,
  WebhookSubscriptionInvalidError,
} from '../domain/webhook-subscription';
import type { WebhookSubscriptionRepository } from '../domain/webhook-subscription.repository';
import { ValidationError } from '@/shared/domain/errors';

// ---------------------------------------------------------------------------
// RegisterSubscriptionUseCase
//
//   入力:  url + description（任意）
//   出力:  作成された WebhookSubscription（secret を含む。レスポンスでは 1 度だけ開示する）
//   副作用: webhook_subscriptions テーブルに 1 行 INSERT
//
//   secret は呼び出し元（controller）が generateWebhookSecret() で採番して渡す。
//   UseCase はその値を Repository に委譲するだけ（domain Entity が長さ検証を行う）。
// ---------------------------------------------------------------------------

export interface RegisterSubscriptionInput {
  url: string;
  secret: string;
  description?: string | null;
}

export const createRegisterSubscriptionUseCase = (
  repo: WebhookSubscriptionRepository,
  logger: AppLogger,
) => {
  return async (input: RegisterSubscriptionInput): Promise<WebhookSubscription> => {
    try {
      const sub = await repo.create({
        url: input.url,
        secret: input.secret,
        description: input.description ?? null,
      });
      logger.info({ subscription_id: sub.id, url: sub.url }, 'Webhook subscription を登録しました');
      return sub;
    } catch (e) {
      // domain 不変条件違反は 400 にマッピング。
      if (e instanceof WebhookSubscriptionInvalidError) {
        throw new ValidationError(e.message, [{ field: 'url', message: e.message }]);
      }
      throw e;
    }
  };
};

export type RegisterSubscriptionUseCase = ReturnType<typeof createRegisterSubscriptionUseCase>;
