import type { WebhookSubscription } from '../domain/webhook-subscription';
import type {
  WebhookSubscriptionListCursor,
  WebhookSubscriptionRepository,
} from '../domain/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// ListSubscriptionsUseCase
//
//   登録済みの Webhook subscription をページネーション付きで一覧する。
//   仕様: created_at DESC, id DESC（新しい順）でキーセット前進。
// ---------------------------------------------------------------------------

export interface ListSubscriptionsInput {
  limit: number;
  after?: WebhookSubscriptionListCursor;
}

export interface ListSubscriptionsOutput {
  subscriptions: WebhookSubscription[];
  nextCursor: WebhookSubscriptionListCursor | null;
}

export const createListSubscriptionsUseCase = (repo: WebhookSubscriptionRepository) => {
  return async (input: ListSubscriptionsInput): Promise<ListSubscriptionsOutput> => {
    return repo.list({ limit: input.limit, after: input.after });
  };
};

export type ListSubscriptionsUseCase = ReturnType<typeof createListSubscriptionsUseCase>;
