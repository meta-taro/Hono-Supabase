import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Webhooks 管理 API のリクエスト・レスポンス定義（Phase 10 Step 7）
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// 配信先 URL は http/https のみ受け付ける（domain でも検証するが、HTTP 層でも先に弾く多重防御）。
const URL_MAX_LENGTH = 2048;
const DESCRIPTION_MAX_LENGTH = 1024;

export const RegisterWebhookSubscriptionRequestSchema = z
  .object({
    url: z
      .string()
      .min(1, { message: 'url は必須です' })
      .max(URL_MAX_LENGTH, { message: `url は ${String(URL_MAX_LENGTH)} 文字以内です` })
      .refine(
        (raw) => {
          try {
            const u = new URL(raw);
            return u.protocol === 'http:' || u.protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'url は http または https の絶対 URL である必要があります' },
      )
      .openapi({ example: 'https://webhook.site/your-uuid' }),
    description: z
      .string()
      .max(DESCRIPTION_MAX_LENGTH, {
        message: `description は ${String(DESCRIPTION_MAX_LENGTH)} 文字以内です`,
      })
      .optional()
      .openapi({
        example: '本番 Slack 通知用（#dev-alerts チャネル）',
        description: '管理者向けメモ（自由記述）',
      }),
  })
  .openapi('RegisterWebhookSubscriptionRequest');

export type RegisterWebhookSubscriptionRequest = z.infer<
  typeof RegisterWebhookSubscriptionRequestSchema
>;

// レスポンス（POST のみ secret を含めて 1 度だけ返す。GET 一覧では secret は返さない）。
export const WebhookSubscriptionWithSecretResponseSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string(),
    description: z.string().nullable(),
    active: z.boolean(),
    secret: z.string().openapi({
      description:
        'HMAC-SHA256 鍵（hex 64 文字）。**この値は登録時にのみ返される。** 失念したら再登録が必要。',
    }),
    created_at: z.string().openapi({ example: '2026-05-25T10:00:00.000Z' }),
    updated_at: z.string().openapi({ example: '2026-05-25T10:00:00.000Z' }),
  })
  .openapi('WebhookSubscriptionWithSecret');

export type WebhookSubscriptionWithSecretResponse = z.infer<
  typeof WebhookSubscriptionWithSecretResponseSchema
>;

export const WebhookSubscriptionResponseSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string(),
    description: z.string().nullable(),
    active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('WebhookSubscription');

export type WebhookSubscriptionResponse = z.infer<typeof WebhookSubscriptionResponseSchema>;

export const ListWebhookSubscriptionsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int({ message: 'limit は整数である必要があります' })
    .min(1, { message: 'limit は 1 以上である必要があります' })
    .max(MAX_LIMIT, { message: `limit は ${String(MAX_LIMIT)} 以下である必要があります` })
    .default(DEFAULT_LIMIT),
  after: z.string().optional(),
});

export type ListWebhookSubscriptionsQuery = z.infer<typeof ListWebhookSubscriptionsQuerySchema>;

export const ListWebhookSubscriptionsResponseSchema = z
  .object({
    subscriptions: z.array(WebhookSubscriptionResponseSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .openapi('ListWebhookSubscriptionsResponse');

export type ListWebhookSubscriptionsResponse = z.infer<
  typeof ListWebhookSubscriptionsResponseSchema
>;

// カーソルの中身（不透明トークンをデコードしたあとの形）。
//   created_at（ISO 8601）+ id（UUID）でキーセット前進。
export const WebhookSubscriptionCursorSchema = z.object({
  created_at: z.string(),
  id: z.string().uuid(),
});

export const SubscriptionIdParamSchema = z.object({
  id: z
    .string()
    .uuid({ message: 'id は UUID 形式である必要があります' })
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export const WebhookDeliveryResponseSchema = z
  .object({
    id: z.string().uuid(),
    event_id: z.string().uuid(),
    subscription_id: z.string().uuid(),
    event_type: z.string(),
    payload: z.unknown(),
    status: z.enum(['pending', 'succeeded', 'failed', 'dead']),
    attempts: z.number().int(),
    last_error: z.string().nullable(),
    next_retry_at: z.string().nullable(),
    succeeded_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('WebhookDelivery');

export type WebhookDeliveryResponse = z.infer<typeof WebhookDeliveryResponseSchema>;

export const ListWebhookDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  after: z.string().optional(),
});

export type ListWebhookDeliveriesQuery = z.infer<typeof ListWebhookDeliveriesQuerySchema>;

export const ListWebhookDeliveriesResponseSchema = z
  .object({
    deliveries: z.array(WebhookDeliveryResponseSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .openapi('ListWebhookDeliveriesResponse');

export type ListWebhookDeliveriesResponse = z.infer<typeof ListWebhookDeliveriesResponseSchema>;

export const WebhookDeliveryCursorSchema = z.object({
  created_at: z.string(),
  id: z.string().uuid(),
});

// 共通エラーレスポンス（CLAUDE.md 統一形式）。
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z
        .array(
          z.object({
            field: z.string(),
            message: z.string(),
          }),
        )
        .optional(),
    }),
  })
  .openapi('WebhookErrorResponse');
