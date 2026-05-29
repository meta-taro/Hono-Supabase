import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { RateLimitMiddlewares } from '@/app';
import { restrictToMethods } from '@/shared/http/rate-limit.middleware';
import { UnauthorizedError } from '@/shared/domain/errors';
import {
  CreateOrderRequestSchema,
  ErrorResponseSchema,
  ListOrdersQuerySchema,
  ListOrdersResponseSchema,
  OrderIdParamSchema,
  OrderResponseSchema,
} from './order.dto';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/' / '/{id}' にする — このルーターは app.ts 側で
//   `app.route('/v1/orders', ...)` でマウントされるため、相対パスを使う。
//
//   Phase 6 で全エンドポイントが認証必須になり、bearerAuth の security を明示する。
//   controller はリクエストごとに c.get('modules').orders から取得する。
// ---------------------------------------------------------------------------

const placeOrderRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['orders'],
  summary: '注文を確定する',
  description:
    '商品の在庫を減算し、注文ヘッダと明細を作成する（Postgres Function でアトミック実行）。' +
    'customerId は JWT subject から解決される（リクエスト body には含めない）。',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateOrderRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成された注文',
      content: { 'application/json': { schema: OrderResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: '注文者の顧客または商品が見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: '在庫不足',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listOrdersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['orders'],
  summary: '自分の注文一覧を取得する（カーソルページネーション）',
  description:
    '認証ユーザー本人の注文を新しい順（placed_at 降順）で返す。RLS により本人の注文のみ可視。' +
    'limit（既定 20・最大 100）で 1 ページ件数を指定し、レスポンスの next_cursor を after に渡して' +
    '次ページを取得する（next_cursor が null なら最終ページ）。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListOrdersQuerySchema,
  },
  responses: {
    200: {
      description: '注文一覧（1 ページ分 + ページネーションメタ）',
      content: { 'application/json': { schema: ListOrdersResponseSchema } },
    },
    400: {
      description: 'limit が範囲外、または after カーソルが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: '認証ユーザーに対応する顧客が見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getOrderRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['orders'],
  summary: '注文詳細を取得する',
  description: 'orderId に対応する注文と明細を返す。RLS により本人の注文のみ可視。',
  security: [{ bearerAuth: [] }],
  request: {
    params: OrderIdParamSchema,
  },
  responses: {
    200: {
      description: '注文詳細',
      content: { 'application/json': { schema: OrderResponseSchema } },
    },
    400: {
      description: 'id が UUID でない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: '注文が見つからない（または本人の注文ではない）',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface OrderRouterDeps {
  // 全エンドポイントに通す認証ガード（fakeAuth 経路も同じ shape）。
  authGuard: MiddlewareHandler<AppEnv>[];
  // Phase 10 Step 5: Rate Limit middleware。未指定なら何も適用しない（テスト最小経路）。
  rateLimits?: RateLimitMiddlewares;
  // Phase 10 Step 6: POST /v1/orders に貼る Idempotency middleware。
  //   未指定なら適用しない（テスト最小経路 / Supabase 未接続）。
  idempotency?: MiddlewareHandler<AppEnv>;
}

export const createOrderRouter = (deps: OrderRouterDeps): OpenAPIHono<AppEnv> => {
  const router = createOpenAPIHono();

  // ルーターレベルで全パスに guard を適用する（POST / と GET /:id 両方）。
  router.use('*', ...deps.authGuard);

  // Phase 10 Step 5: orders は全エンドポイントが認証必須で、user 単位 quota が望ましいので
  //   authWrite を全パスに一律で乗せる（GET 系も含む）。authGuard 直後に貼ることで
  //   user が確定した状態で limit({ key: 'user:<id>' }) が呼ばれる。
  //   注意: authWrite は「user キーで limit する authenticated 系」を意味し、GET も含む。
  //   bindings 名（LIMITER_AUTH_WRITE）の "write" は wrangler.toml 都合の名残。
  if (deps.rateLimits) router.use('*', deps.rateLimits.authWrite);

  // Phase 10 Step 6: POST / にだけ Idempotency middleware を貼る（GET 系は対象外）。
  //   順序は rate-limit → auth → idempotency。auth が先に通っているので user が確定済み、
  //   idempotency store の owner キーに user.id をそのまま使える。
  //   `/` パスは GET と POST で共有のため restrictToMethods で POST のみに絞る。
  if (deps.idempotency) router.use('/', restrictToMethods(['POST'], deps.idempotency));

  router.openapi(placeOrderRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証情報が取得できませんでした');
    }
    const controller = c.get('modules').orders;
    const input = c.req.valid('json');
    const body = await controller.place(user.id, input);
    return c.json(body, 201);
  });

  router.openapi(listOrdersRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証情報が取得できませんでした');
    }
    const controller = c.get('modules').orders;
    const query = c.req.valid('query');
    const body = await controller.list(user.id, query);

    // RFC 5988 Link ヘッダで次ページ URL を提示する（body の next_cursor と二重提供）。
    if (body.next_cursor) {
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set('limit', String(query.limit));
      nextUrl.searchParams.set('after', body.next_cursor);
      c.header('Link', `<${nextUrl.toString()}>; rel="next"`);
    }

    return c.json(body, 200);
  });

  router.openapi(getOrderRoute, async (c) => {
    const controller = c.get('modules').orders;
    const { id } = c.req.valid('param');
    const body = await controller.get(id);
    return c.json(body, 200);
  });

  return router;
};
