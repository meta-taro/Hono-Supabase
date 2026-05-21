import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import {
  CakeResponseSchema,
  CreateCakeRequestSchema,
  ErrorResponseSchema,
  ListCakesQuerySchema,
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
  summary: 'ケーキ一覧を取得する（カーソルページネーション + ソート/フィルタ）',
  description:
    'ケーキ一覧を返す（認証不要）。limit（既定 20・最大 100）で 1 ページ件数を指定し、' +
    'next_cursor を after に渡して次ページを取得する（null なら最終ページ）。' +
    "sort で並び替え（'-' 降順・カンマ区切り、許可: name/price/stock、既定 name 昇順）、" +
    'available / min_price / max_price / q で絞り込みができる。' +
    'after を付けて取得する際は、カーソル発行時と同じ sort でなければ 400 になる。',
  request: {
    query: ListCakesQuerySchema,
  },
  responses: {
    200: {
      description: 'ケーキ一覧（1 ページ分 + ページネーションメタ）',
      content: { 'application/json': { schema: ListCakesResponseSchema } },
    },
    400: {
      description: 'limit が範囲外、または after カーソルが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
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
  const router = createOpenAPIHono();

  router.openapi(listCakesRoute, async (c) => {
    const controller = c.get('modules').cakes;
    const query = c.req.valid('query');
    const body = await controller.list(query);

    // RFC 5988 Link ヘッダで次ページ URL を提示する（body の next_cursor と二重提供）。
    // クライアントは Link を辿るだけで次ページに進める（HATEOAS 的な利便性）。
    if (body.next_cursor) {
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set('limit', String(query.limit));
      nextUrl.searchParams.set('after', body.next_cursor);
      c.header('Link', `<${nextUrl.toString()}>; rel="next"`);
    }

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
