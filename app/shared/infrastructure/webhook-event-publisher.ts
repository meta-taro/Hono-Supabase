import type { EventPublisher } from '@/shared/application/event-publisher';
import type { WebhookEvent } from '@/shared/domain/webhook-event';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { WebhookDeliveryRepository } from '@/modules/webhooks/domain/webhook-delivery.repository';
import type { WebhookSubscriptionRepository } from '@/modules/webhooks/domain/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// WebhookEventPublisher
//
//   役割:
//     - ドメインイベント受領時に「アクティブな全 subscription 分の deliveries 行」を enqueue する。
//     - UNIQUE(event_id, subscription_id) 制約により再 publish しても重複しない。
//
//   throw 規約:
//     listForPublish / enqueue で予期せぬ失敗が起きても throw しない。
//     失敗は warn ログだけ残し、注文確定（呼び出し元の UseCase）は守る。
//     これにより「副系（webhooks）が落ちても主系（orders）が連れ落ちない」可用性を担保する。
//
//   再試行ループ（dispatch）はここでは触らない:
//     publish は「行を生やす」までが責務。配信ループは middleware（webhook-dispatch.middleware）
//     が次のリクエストで肩代わりする（リクエスト駆動 retry）。
// ---------------------------------------------------------------------------

export interface WebhookEventPublisherDeps {
  subscriptionRepo: WebhookSubscriptionRepository;
  deliveryRepo: WebhookDeliveryRepository;
  logger: AppLogger;
}

export const createWebhookEventPublisher = (deps: WebhookEventPublisherDeps): EventPublisher => {
  const { subscriptionRepo, deliveryRepo, logger } = deps;
  return {
    publish: async (event: WebhookEvent): Promise<void> => {
      let subs;
      try {
        subs = await subscriptionRepo.listForPublish();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'unknown error';
        logger.warn(
          { event_id: event.event_id, event_type: event.event_type, message },
          'Webhook: subscription 一覧取得に失敗（配信スキップ）',
        );
        return;
      }
      if (subs.length === 0) {
        // 公開リポジトリ運用デフォルト（subscription 0 件）はここに来る。完全に no-op。
        return;
      }
      for (const sub of subs) {
        try {
          await deliveryRepo.enqueue({ event, subscriptionId: sub.id });
        } catch (e) {
          const message = e instanceof Error ? e.message : 'unknown error';
          // 1 件失敗しても他の subscription への enqueue を続ける（部分失敗を許容）。
          logger.warn(
            {
              event_id: event.event_id,
              event_type: event.event_type,
              subscription_id: sub.id,
              message,
            },
            'Webhook: delivery の enqueue に失敗（他 sub の処理は継続）',
          );
        }
      }
    },
  };
};
