import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import {
  CakeResponseSchema,
  CreateCakeRequestSchema,
  ErrorResponseSchema,
  ListCakesResponseSchema,
} from './cake.dto';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/' にする — このルーターは app.ts 側で `app.route('/v1/cakes', ...)` で
//   マウントされるため、ここでは相対パスを使う（重複定義防止）。
//
//   Phase 6 で controller はリクエストごとに c.get('modules').cakes から取得する。
//   ルーター本体は副作用を持たず、ミドルウェア構成だけを受け取る。
// ---------------------------------------------------------------------------

const listCakesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['cakes'],
  summary: 'ケーキ一覧を取得する',
  description: 'すべてのケーキを名前昇順で返す。認証不要。',
  responses: {
    200: {
      description: 'ケーキ一覧',
      content: { 'application/json': { schema: ListCakesResponseSchema } },
    },
  },
});

const createCakeRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['cakes'],
  summary: 'ケーキを登録する（管理者専用）',
  description:
    '新しいケーキをカタログに追加する。admin ロール必須（authMiddleware + requireAdmin）。',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateCakeRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成されたケーキ',
      content: { 'application/json': { schema: CakeResponseSchema } },
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
    409: {
      description: 'ID が重複している',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface CakeRouterDeps {
  // POST /v1/cakes の前に挟むミドルウェア配列（認証 + admin 強制）。
  adminGuard: MiddlewareHandler<AppEnv>[];
}

export const createCakeRouter = (deps: CakeRouterDeps): OpenAPIHono<AppEnv> => {
  const router = createOpenAPIHono<AppEnv>();

  router.openapi(listCakesRoute, async (c) => {
    const controller = c.get('modules').cakes;
    const body = await controller.list();
    return c.json(body, 200);
  });

  router.use(createCakeRoute.getRoutingPath(), ...deps.adminGuard);
  router.openapi(createCakeRoute, async (c) => {
    const controller = c.get('modules').cakes;
    const input = c.req.valid('json');
    const body = await controller.create(input);
    return c.json(body, 201);
  });

  return router;
};
