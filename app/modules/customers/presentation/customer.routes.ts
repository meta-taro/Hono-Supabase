import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { RateLimitMiddlewares } from '@/app';
import { restrictToMethods } from '@/shared/http/rate-limit.middleware';
import {
  CustomerResponseSchema,
  SignUpCustomerRequestSchema,
  ErrorResponseSchema,
  ListCustomersResponseSchema,
} from './customer.dto';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/' にする — このルーターは app.ts 側で `app.route('/v1/customers', ...)` で
//   マウントされるため、ここでは相対パスを使う（重複定義防止）。
//
//   Phase 6 で controller はリクエストごとに c.get('modules').customers から取得する。
// ---------------------------------------------------------------------------

const listCustomersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['customers'],
  summary: '顧客一覧を取得する（管理者専用）',
  description: 'すべての顧客を名前昇順で返す。admin ロール必須。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '顧客一覧',
      content: { 'application/json': { schema: ListCustomersResponseSchema } },
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

const signUpCustomerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['customers'],
  summary: 'サインアップ（顧客登録）',
  description:
    'Supabase Auth にユーザを登録し、DB トリガで customers 行を 1 トランザクション内に作成する。' +
    'email は VO で正規化、password は Auth が bcrypt 等で安全に保存する。認証不要。',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: SignUpCustomerRequestSchema } },
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

export interface CustomerRouterDeps {
  // GET /v1/customers の前に挟む認証 + admin 強制ミドルウェア。
  adminGuard: MiddlewareHandler<AppEnv>[];
  // Phase 10 Step 5: Rate Limit middleware。未指定なら何も適用しない（テスト最小経路）。
  rateLimits?: RateLimitMiddlewares;
}

export const createCustomerRouter = (deps: CustomerRouterDeps): OpenAPIHono<AppEnv> => {
  const router = createOpenAPIHono();
  const rl = deps.rateLimits;

  // Hono の `router.use(path, mw)` は「呼んだ時点以降に登録される handler」だけに mw を適用する。
  // signUp（公開・認証不要）を **adminGuard より先に** 登録することで、
  // POST / に guard が混入しないようにする。cakes の構造と統一。
  //
  // Phase 10 Step 5:
  //   - POST / (signUp)  → publicWrite (5/60s per IP) — サインアップは認証前なので IP キー
  //   - GET  / (admin)    → authWrite (10/10s per user) — adminGuard で認証済みのため user キー
  //   path が同じ '/' なので restrictToMethods で method を絞る。
  if (rl) router.use('/', restrictToMethods(['POST'], rl.publicWrite));
  router.openapi(signUpCustomerRoute, async (c) => {
    const controller = c.get('modules').customers;
    const input = c.req.valid('json');
    const body = await controller.signUp(input);
    return c.json(body, 201);
  });

  router.use(listCustomersRoute.getRoutingPath(), ...deps.adminGuard);
  if (rl) router.use(listCustomersRoute.getRoutingPath(), restrictToMethods(['GET'], rl.authWrite));
  router.openapi(listCustomersRoute, async (c) => {
    const controller = c.get('modules').customers;
    const body = await controller.list();
    return c.json(body, 200);
  });

  return router;
};
