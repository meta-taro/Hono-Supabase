import type { WebhookDispatcher } from '@/shared/application/webhook-dispatcher';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { WebhookDeliveryRepository } from '@/modules/webhooks/domain/webhook-delivery.repository';
import { nextRetryDelayMs } from '@/modules/webhooks/domain/webhook-delivery';

// ---------------------------------------------------------------------------
// dispatchPendingDeliveries: pending/failed の retry 可能 delivery を 1 ラウンド配信する。
//
//   設計:
//     - 1 回のリクエストで raise する処理量を抑えるため limit を渡す（既定 5）。
//     - 失敗時の next_retry_at は domain の nextRetryDelayMs（指数バックオフ）が計算する。
//       attempts >= MAX_ATTEMPTS で null（dead）になる。
//     - dispatcher / repo / logger は port 渡し。本番では SupabaseWebhookDeliveryRepository
//       + FetchWebhookDispatcher が注入される。
//
//   呼び出し戦略:
//     - リクエスト駆動: webhook-dispatch.middleware が「リクエスト 1 件処理後」に
//       ctx.waitUntil(dispatchPendingDeliveries(...)) で叩く。これにより外部 cron 不要。
//     - cron 駆動も可能（将来 Cloudflare Cron Trigger に置き換えるとしてもこの関数の
//       interface は変わらない）。
// ---------------------------------------------------------------------------

export interface DispatchPendingDeliveriesDeps {
  deliveryRepo: WebhookDeliveryRepository;
  dispatcher: WebhookDispatcher;
  logger: AppLogger;
  // 1 ラウンドで処理する最大件数。次回 retry のキャパシティを考慮して 5 件程度に絞る。
  limit?: number;
  // 現在時刻のソース（テストで差し替え可能）。
  now?: () => Date;
}

const DEFAULT_LIMIT = 5;

export interface DispatchPendingDeliveriesResult {
  attempted: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export const dispatchPendingDeliveries = async (
  deps: DispatchPendingDeliveriesDeps,
): Promise<DispatchPendingDeliveriesResult> => {
  const { deliveryRepo, dispatcher, logger, limit = DEFAULT_LIMIT, now = () => new Date() } = deps;
  const due = await deliveryRepo.listDue({ now: now(), limit });

  let succeeded = 0;
  let failed = 0;
  let dead = 0;

  for (const { delivery, url, secret } of due) {
    try {
      const result = await dispatcher.deliver(delivery.payload, { url, secret });
      if (result.kind === 'succeeded') {
        await deliveryRepo.markSucceeded(delivery.id, now());
        succeeded += 1;
        continue;
      }
      // 失敗: attempts+1 後の次回 retry 遅延を domain から取得し、null なら dead に倒す。
      const nextAttempts = delivery.attempts + 1;
      const delayMs = nextRetryDelayMs(nextAttempts);
      const nextRetryAt = delayMs === null ? null : new Date(now().getTime() + delayMs);
      await deliveryRepo.markFailed(delivery.id, {
        errorMessage: result.message,
        nextRetryAt,
      });
      if (nextRetryAt === null) dead += 1;
      else failed += 1;
    } catch (e) {
      // dispatcher / repo の例外で全体が止まらないよう、個別 delivery のエラーは握って継続。
      const message = e instanceof Error ? e.message : 'unknown error';
      logger.warn(
        { delivery_id: delivery.id, subscription_id: delivery.subscriptionId, message },
        'Webhook dispatch: 個別 delivery の処理で例外（次の delivery を継続）',
      );
      // 例外も 1 回の失敗としてカウントしたいので、可能なら markFailed を呼ぶ（ベストエフォート）。
      try {
        const nextAttempts = delivery.attempts + 1;
        const delayMs = nextRetryDelayMs(nextAttempts);
        const nextRetryAt = delayMs === null ? null : new Date(now().getTime() + delayMs);
        await deliveryRepo.markFailed(delivery.id, { errorMessage: message, nextRetryAt });
        if (nextRetryAt === null) dead += 1;
        else failed += 1;
      } catch {
        // ここまで来たら DB 側も壊れている。次リクエストで listDue が再度拾うのを期待する。
      }
    }
  }

  return { attempted: due.length, succeeded, failed, dead };
};
