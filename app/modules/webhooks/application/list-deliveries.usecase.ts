import { NotFoundError } from '@/shared/domain/errors';
import type {
  ListDeliveriesBySubscriptionCursor,
  WebhookDeliveryRepository,
} from '../domain/webhook-delivery.repository';
import type { WebhookDelivery } from '../domain/webhook-delivery';
import type { WebhookSubscriptionRepository } from '../domain/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// ListDeliveriesUseCase
//
//   subscription 別の配信履歴を新しい順でページネーション返却。
//   subscription が存在しない（または削除済み）なら 404 に倒す。
// ---------------------------------------------------------------------------

export interface ListDeliveriesInput {
  subscriptionId: string;
  limit: number;
  after?: ListDeliveriesBySubscriptionCursor;
}

export interface ListDeliveriesOutput {
  deliveries: WebhookDelivery[];
  nextCursor: ListDeliveriesBySubscriptionCursor | null;
}

export const createListDeliveriesUseCase = (
  subscriptionRepo: WebhookSubscriptionRepository,
  deliveryRepo: WebhookDeliveryRepository,
) => {
  return async (input: ListDeliveriesInput): Promise<ListDeliveriesOutput> => {
    const sub = await subscriptionRepo.findById(input.subscriptionId);
    if (!sub) {
      throw new NotFoundError(`Webhook subscription (id=${input.subscriptionId}) が見つかりません`);
    }
    return deliveryRepo.listBySubscription({
      subscriptionId: input.subscriptionId,
      limit: input.limit,
      after: input.after,
    });
  };
};

export type ListDeliveriesUseCase = ReturnType<typeof createListDeliveriesUseCase>;
