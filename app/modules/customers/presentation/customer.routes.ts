import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import {
  CustomerResponseSchema,
  CreateCustomerRequestSchema,
  ErrorResponseSchema,
  ListCustomersResponseSchema,
} from './customer.dto';
import type { CustomerController } from './customer.controller';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/' にする — このルーターは app.ts 側で `app.route('/v1/customers', ...)` で
//   マウントされるため、ここでは相対パスを使う（重複定義防止）。
// ---------------------------------------------------------------------------

const listCustomersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['customers'],
  summary: '顧客一覧を取得する',
  description:
    'すべての顧客を名前昇順で返す。Phase 6 で管理者ロール必須に変更予定。',
  responses: {
    200: {
      description: '顧客一覧',
      content: { 'application/json': { schema: ListCustomersResponseSchema } },
    },
  },
});

const createCustomerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['customers'],
  summary: '顧客を登録する（サインアップ相当）',
  description:
    '新規顧客を登録する。メールアドレスはアプリ層で正規化（lowercase + trim）され、'
    + 'DB の UNIQUE 制約と CHECK 制約で形式・一意性を担保する。認証不要。',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateCustomerRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成された顧客',
      content: { 'application/json': { schema: CustomerResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'メールアドレスが既に登録されている',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router ファクトリ
//   Controller を引数にもらうことで、本番でも統合テストでも同じ構造で組める。
// ---------------------------------------------------------------------------
export const createCustomerRouter = (controller: CustomerController): OpenAPIHono => {
  const router = createOpenAPIHono();

  router.openapi(listCustomersRoute, async (c) => {
    const body = await controller.list();
    return c.json(body, 200);
  });

  router.openapi(createCustomerRoute, async (c) => {
    const input = c.req.valid('json');
    const body = await controller.create(input);
    return c.json(body, 201);
  });

  return router;
};
