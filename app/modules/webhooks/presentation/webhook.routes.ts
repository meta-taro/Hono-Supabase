import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { RateLimitMiddlewares } from '@/app';
import { restrictToMethods } from '@/shared/http/rate-limit.middleware';
import {
  ErrorResponseSchema,
  ListWebhookDeliveriesQuerySchema,
  ListWebhookDeliveriesResponseSchema,
  ListWebhookSubscriptionsQuerySchema,
  ListWebhookSubscriptionsResponseSchema,
  RegisterWebhookSubscriptionRequestSchema,
  SubscriptionIdParamSchema,
  WebhookSubscriptionWithSecretResponseSchema,
} from './webhook.dto';

// ---------------------------------------------------------------------------
// Webhooks 管理 API の Route 定義
//   全エンドポイント admin ロール必須（adminGuard）。
//   composition-root が WebhookController を c.var.modules.webhooks に積む前提。
// ---------------------------------------------------------------------------

const registerSubscriptionRoute = createRoute({
  method: 'post',
  path: '/subscriptions',
  tags: ['webhooks'],
  summary: 'Webhook サブスクリプションを登録する（管理者専用）',
  description:
    '配信先 URL を登録し、HMAC-SHA256 鍵（secret）を生成して 1 度だけ返す。' +
    'secret は再表示できないため、レスポンス受信後に安全な場所に保管すること。',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: RegisterWebhookSubscriptionRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成されたサブスクリプション（secret を含む。1 度だけ開示）',
      content: { 'application/json': { schema: WebhookSubscriptionWithSecretResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: '管理者権限なし',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listSubscriptionsRoute = createRoute({
  method: 'get',
  path: '/subscriptions',
  tags: ['webhooks'],
  summary: 'Webhook サブスクリプション一覧（管理者専用）',
  description:
    'created_at DESC でキーセットページネーション。secret は返らない（POST 時のみ開示）。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListWebhookSubscriptionsQuerySchema,
  },
  responses: {
    200: {
      description: 'サブスクリプション一覧',
      content: { 'application/json': { schema: ListWebhookSubscriptionsResponseSchema } },
    },
    400: {
      description: 'limit 範囲外 / after カーソル不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: '管理者権限なし',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteSubscriptionRoute = createRoute({
  method: 'delete',
  path: '/subscriptions/{id}',
  tags: ['webhooks'],
  summary: 'Webhook サブスクリプションを削除する（管理者専用）',
  description: '紐づく webhook_deliveries 行も cascade delete で消える。',
  security: [{ bearerAuth: [] }],
  request: {
    params: SubscriptionIdParamSchema,
  },
  responses: {
    204: { description: '削除成功' },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: '管理者権限なし',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'サブスクリプションが見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listDeliveriesRoute = createRoute({
  method: 'get',
  path: '/subscriptions/{id}/deliveries',
  tags: ['webhooks'],
  summary: 'サブスクリプション別の配信履歴（管理者専用）',
  description:
    'created_at DESC でキーセットページネーション。status / attempts / last_error / next_retry_at を含む。',
  security: [{ bearerAuth: [] }],
  request: {
    params: SubscriptionIdParamSchema,
    query: ListWebhookDeliveriesQuerySchema,
  },
  responses: {
    200: {
      description: '配信履歴一覧',
      content: { 'application/json': { schema: ListWebhookDeliveriesResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: '管理者権限なし',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'サブスクリプションが見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface WebhookRouterDeps {
  adminGuard: MiddlewareHandler<AppEnv>[];
  rateLimits?: RateLimitMiddlewares;
  // POST /subscriptions に貼る Idempotency middleware（任意）。
  idempotency?: MiddlewareHandler<AppEnv>;
}

export const createWebhookRouter = (deps: WebhookRouterDeps): OpenAPIHono<AppEnv> => {
  const router = createOpenAPIHono();
  const rl = deps.rateLimits;

  // すべてのエンドポイントが管理者専用。先頭で全パスに admin guard を貼る。
  router.use('*', ...deps.adminGuard);

  // Rate Limit:
  //   全エンドポイント認証必須なので authWrite を全パスに貼る（user キーで quota 管理）。
  if (rl) router.use('*', rl.authWrite);

  // POST /subscriptions に Idempotency middleware を貼る（GET 系は対象外）。
  //   path は GET と共有するため restrictToMethods で POST のみに絞る。
  if (deps.idempotency) {
    router.use(
      registerSubscriptionRoute.getRoutingPath(),
      restrictToMethods(['POST'], deps.idempotency),
    );
  }

  router.openapi(registerSubscriptionRoute, async (c) => {
    const controller = c.get('modules').webhooks;
    const input = c.req.valid('json');
    const body = await controller.register(input);
    return c.json(body, 201);
  });

  router.openapi(listSubscriptionsRoute, async (c) => {
    const controller = c.get('modules').webhooks;
    const query = c.req.valid('query');
    const body = await controller.list(query);
    if (body.next_cursor) {
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set('limit', String(query.limit));
      nextUrl.searchParams.set('after', body.next_cursor);
      c.header('Link', `<${nextUrl.toString()}>; rel="next"`);
    }
    return c.json(body, 200);
  });

  router.openapi(deleteSubscriptionRoute, async (c) => {
    const controller = c.get('modules').webhooks;
    const { id } = c.req.valid('param');
    await controller.delete(id);
    return c.body(null, 204);
  });

  router.openapi(listDeliveriesRoute, async (c) => {
    const controller = c.get('modules').webhooks;
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    const body = await controller.listDeliveries(id, query);
    if (body.next_cursor) {
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set('limit', String(query.limit));
      nextUrl.searchParams.set('after', body.next_cursor);
      c.header('Link', `<${nextUrl.toString()}>; rel="next"`);
    }
    return c.json(body, 200);
  });

  return router;
};
