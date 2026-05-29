import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { WebhookDispatcher } from '@/shared/application/webhook-dispatcher';
import type { WebhookDeliveryRepository } from '@/modules/webhooks/domain/webhook-delivery.repository';
import { dispatchPendingDeliveries } from './dispatch-pending-deliveries';

// ---------------------------------------------------------------------------
// Webhook dispatch ミドルウェア（Phase 10 Step 7）
//
//   何をするか:
//     - レスポンス送出後に c.executionCtx.waitUntil で dispatchPendingDeliveries を回す
//     - これによりリクエスト処理のレイテンシに影響を与えず retry ループを進められる
//     - Cloudflare Workers の waitUntil は最大 30 秒程度の余韻実行を保証する
//
//   なぜリクエスト駆動か:
//     - 本プロジェクトは Workers Free プランで運用するため Cron Triggers を「常時動作」と
//       想定するのは過剰（必要に応じて後付け可能）。
//     - 「リクエストが来るたびに pending を 1 ラウンド片付ける」ことで、トラフィックがある限り
//       retry は自然に進む（外部スケジューラ不要）。
//
//   Node ローカル経路:
//     - c.executionCtx は存在しないため、noop ミドルウェアに倒す（dispatch 自体は管理 API 経由で
//       明示トリガできる構造を残す。最小経路では「webhook は配信しないが API は動く」状態）。
// ---------------------------------------------------------------------------

export interface WebhookDispatchMiddlewareOptions {
  deliveryRepo: WebhookDeliveryRepository;
  dispatcher: WebhookDispatcher;
  // 1 リクエストあたりに処理する delivery 件数の上限（既定 5）。
  limit?: number;
}

export const createWebhookDispatchMiddleware = (
  options: WebhookDispatchMiddlewareOptions,
): MiddlewareHandler<AppEnv> => {
  const { deliveryRepo, dispatcher, limit } = options;
  return async (c, next) => {
    await next();
    // Workers では c.executionCtx.waitUntil で背景タスクを継続する。
    // ctx が無い経路（テスト最小 / Node ローカル）の場合、hono の getter は throw するため
    // try/catch でフォールバックする（型上は常に non-null 扱いだが、実行時には未定義もある）。
    let ctx: typeof c.executionCtx | null;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    // logger は per-request スコープがあればそちらを優先（requestId 等が乗る）。
    const logger = c.var.logger;
    if (!logger) return;
    ctx.waitUntil(
      dispatchPendingDeliveries({
        deliveryRepo,
        dispatcher,
        logger,
        limit,
      }).then(
        () => undefined,
        (e: unknown) => {
          // dispatchPendingDeliveries 自体が throw した場合（listDue 失敗等）の最終 catch。
          // waitUntil に rejected な Promise を流すと Workers のメトリクスで unhandled に
          // なるため、ここで握って warn ログにする。
          const message = e instanceof Error ? e.message : 'unknown error';
          logger.warn({ message }, 'Webhook dispatch ループが例外で停止しました');
        },
      ),
    );
  };
};

// dispatcher / deliveryRepo が未注入時の素通しミドルウェア。Node ローカル / 最小テスト用。
export const noopWebhookDispatchMiddleware: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};
