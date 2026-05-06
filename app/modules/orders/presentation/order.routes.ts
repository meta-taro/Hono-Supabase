import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import {
  CreateOrderRequestSchema,
  ErrorResponseSchema,
  OrderIdParamSchema,
  OrderResponseSchema,
} from './order.dto';
import type { OrderController } from './order.controller';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/' / '/{id}' にする — このルーターは app.ts 側で
//   `app.route('/v1/orders', ...)` でマウントされるため、相対パスを使う。
// ---------------------------------------------------------------------------

const placeOrderRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['orders'],
  summary: '注文を確定する',
  description:
    '商品の在庫を減算し、注文ヘッダと明細を作成する（Postgres Function でアトミック実行）。' +
    'Phase 6 で customerId は JWT subject から取得する形に変更予定。',
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

const getOrderRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['orders'],
  summary: '注文詳細を取得する',
  description:
    'orderId に対応する注文と明細を返す。Phase 6 で「本人のみ」認可を追加予定。',
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
    404: {
      description: '注文が見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const createOrderRouter = (controller: OrderController): OpenAPIHono => {
  const router = createOpenAPIHono();

  router.openapi(placeOrderRoute, async (c) => {
    const input = c.req.valid('json');
    const body = await controller.place(input);
    return c.json(body, 201);
  });

  router.openapi(getOrderRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = await controller.get(id);
    return c.json(body, 200);
  });

  return router;
};
