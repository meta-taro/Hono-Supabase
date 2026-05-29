import type { AppLogger } from '@/shared/infrastructure/logger';
import { NotFoundError } from '@/shared/domain/errors';
import type { WebhookSubscriptionRepository } from '../domain/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// DeleteSubscriptionUseCase
//
//   subscription を 1 件削除する（DB 側で cascade delete により紐づく deliveries も消える）。
//   未存在の id は NotFoundError(404) に倒す。
// ---------------------------------------------------------------------------

export interface DeleteSubscriptionInput {
  id: string;
}

export const createDeleteSubscriptionUseCase = (
  repo: WebhookSubscriptionRepository,
  logger: AppLogger,
) => {
  return async (input: DeleteSubscriptionInput): Promise<void> => {
    const deleted = await repo.delete(input.id);
    if (!deleted) {
      throw new NotFoundError(`Webhook subscription (id=${input.id}) が見つかりません`);
    }
    logger.info({ subscription_id: input.id }, 'Webhook subscription を削除しました');
  };
};

export type DeleteSubscriptionUseCase = ReturnType<typeof createDeleteSubscriptionUseCase>;
