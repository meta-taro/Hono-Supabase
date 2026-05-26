import { decodeCursor, encodeCursor } from '@/shared/http/cursor';
import { generateWebhookSecret } from '@/shared/http/webhook-signature';
import type { WebhookDelivery } from '../domain/webhook-delivery';
import type { WebhookSubscription } from '../domain/webhook-subscription';
import type { RegisterSubscriptionUseCase } from '../application/register-subscription.usecase';
import type { ListSubscriptionsUseCase } from '../application/list-subscriptions.usecase';
import type { DeleteSubscriptionUseCase } from '../application/delete-subscription.usecase';
import type { ListDeliveriesUseCase } from '../application/list-deliveries.usecase';
import {
  type ListWebhookDeliveriesQuery,
  type ListWebhookDeliveriesResponse,
  type ListWebhookSubscriptionsQuery,
  type ListWebhookSubscriptionsResponse,
  type RegisterWebhookSubscriptionRequest,
  type WebhookDeliveryResponse,
  type WebhookSubscriptionResponse,
  type WebhookSubscriptionWithSecretResponse,
  WebhookDeliveryCursorSchema,
  WebhookSubscriptionCursorSchema,
} from './webhook.dto';

// ---------------------------------------------------------------------------
// Webhook Controller
//
//   役割:
//     - UseCase を呼び出して domain Entity を Response DTO に変換する
//     - secret は POST 時のみレスポンスで開示し、GET 一覧では落とす
//     - 不透明カーソルのエンコード/デコード（cursor.ts）
// ---------------------------------------------------------------------------

const toSubscriptionResponse = (s: WebhookSubscription): WebhookSubscriptionResponse => ({
  id: s.id,
  url: s.url,
  description: s.description,
  active: s.active,
  created_at: s.createdAt.toISOString(),
  updated_at: s.updatedAt.toISOString(),
});

const toSubscriptionWithSecretResponse = (
  s: WebhookSubscription,
): WebhookSubscriptionWithSecretResponse => ({
  id: s.id,
  url: s.url,
  description: s.description,
  active: s.active,
  secret: s.secret,
  created_at: s.createdAt.toISOString(),
  updated_at: s.updatedAt.toISOString(),
});

const toDeliveryResponse = (d: WebhookDelivery): WebhookDeliveryResponse => ({
  id: d.id,
  event_id: d.eventId,
  subscription_id: d.subscriptionId,
  event_type: d.eventType,
  payload: d.payload,
  status: d.status,
  attempts: d.attempts,
  last_error: d.lastError,
  next_retry_at: d.nextRetryAt ? d.nextRetryAt.toISOString() : null,
  succeeded_at: d.succeededAt ? d.succeededAt.toISOString() : null,
  created_at: d.createdAt.toISOString(),
});

export interface WebhookControllerDeps {
  registerSubscription: RegisterSubscriptionUseCase;
  listSubscriptions: ListSubscriptionsUseCase;
  deleteSubscription: DeleteSubscriptionUseCase;
  listDeliveries: ListDeliveriesUseCase;
  // secret 生成は注入可能にする（テストで固定値にしたい場合 / アルゴリズム差し替え対応）。
  // 既定は generateWebhookSecret（Web Crypto ベース 32 バイト hex）。
  generateSecret?: () => string;
}

export const createWebhookController = (deps: WebhookControllerDeps) => {
  const generateSecret = deps.generateSecret ?? generateWebhookSecret;
  return {
    register: async (
      input: RegisterWebhookSubscriptionRequest,
    ): Promise<WebhookSubscriptionWithSecretResponse> => {
      // secret は controller でだけ採番し、UseCase はそれを受け取って保存する。
      // この設計で「秘匿値の生成タイミングと出力経路」を 1 か所に閉じ込める。
      const secret = generateSecret();
      const sub = await deps.registerSubscription({
        url: input.url,
        secret,
        description: input.description ?? null,
      });
      return toSubscriptionWithSecretResponse(sub);
    },

    list: async (
      query: ListWebhookSubscriptionsQuery,
    ): Promise<ListWebhookSubscriptionsResponse> => {
      const after = query.after
        ? (() => {
            const decoded = decodeCursor(query.after, WebhookSubscriptionCursorSchema);
            return { createdAt: decoded.created_at, id: decoded.id };
          })()
        : undefined;
      const result = await deps.listSubscriptions({ limit: query.limit, after });
      const nextCursor = result.nextCursor
        ? encodeCursor({ created_at: result.nextCursor.createdAt, id: result.nextCursor.id })
        : null;
      return {
        subscriptions: result.subscriptions.map(toSubscriptionResponse),
        next_cursor: nextCursor,
        has_more: nextCursor !== null,
      };
    },

    delete: async (id: string): Promise<void> => {
      await deps.deleteSubscription({ id });
    },

    listDeliveries: async (
      subscriptionId: string,
      query: ListWebhookDeliveriesQuery,
    ): Promise<ListWebhookDeliveriesResponse> => {
      const after = query.after
        ? (() => {
            const decoded = decodeCursor(query.after, WebhookDeliveryCursorSchema);
            return { createdAt: decoded.created_at, id: decoded.id };
          })()
        : undefined;
      const result = await deps.listDeliveries({ subscriptionId, limit: query.limit, after });
      const nextCursor = result.nextCursor
        ? encodeCursor({ created_at: result.nextCursor.createdAt, id: result.nextCursor.id })
        : null;
      return {
        deliveries: result.deliveries.map(toDeliveryResponse),
        next_cursor: nextCursor,
        has_more: nextCursor !== null,
      };
    },
  };
};

export type WebhookController = ReturnType<typeof createWebhookController>;
