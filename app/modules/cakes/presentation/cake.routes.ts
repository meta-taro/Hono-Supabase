import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import {
  CakeIdParamSchema,
  CakeResponseSchema,
  CreateCakeRequestSchema,
  ErrorResponseSchema,
  ListCakesQuerySchema,
  ListCakesResponseSchema,
  UpdateCakeStockRequestSchema,
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

// ETag を返すレスポンスヘッダの OpenAPI 定義（GET 単一 / PATCH で共用）。
const etagResponseHeader = {
  ETag: {
    description: 'リソースの版を表す Weak ETag（例: W/"7"）。PATCH の If-Match にそのまま使う。',
    schema: { type: 'string' as const, example: 'W/"7"' },
  },
};

const getCakeByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['cakes'],
  summary: 'ケーキ 1 件を取得する（ETag 付き）',
  description:
    'id に対応するケーキを返す（認証不要）。レスポンスの ETag ヘッダに現在の版が載るので、' +
    '在庫更新（PATCH）時はこの ETag を If-Match に指定して楽観ロックを効かせる。',
  request: {
    params: CakeIdParamSchema,
  },
  responses: {
    200: {
      description: 'ケーキ 1 件',
      headers: etagResponseHeader,
      content: { 'application/json': { schema: CakeResponseSchema } },
    },
    400: {
      description: 'id が UUID でない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'ケーキが見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateCakeStockRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['cakes'],
  summary: 'ケーキの在庫を更新する（管理者専用・楽観ロック）',
  description:
    '在庫数（絶対値）を更新する。admin ロール必須。更新競合を防ぐため If-Match ヘッダ必須' +
    '（GET /v1/cakes/{id} で得た ETag を指定する）。版が一致しなければ 412、未指定なら 428 を返す。',
  security: [{ bearerAuth: [] }],
  request: {
    params: CakeIdParamSchema,
    headers: z.object({
      'if-match': z.string().optional().openapi({
        example: 'W/"7"',
        description: '更新対象の現在の版（GET で取得した ETag）。必須。',
      }),
    }),
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateCakeStockRequestSchema } },
    },
  },
  responses: {
    200: {
      description: '更新後のケーキ（ETag は採番後の新しい版）',
      headers: etagResponseHeader,
      content: { 'application/json': { schema: CakeResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータまたは If-Match の形式が不正',
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
    404: {
      description: 'ケーキが見つからない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    412: {
      description: 'If-Match の版が現在の版と一致しない（競合）',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    428: {
      description: 'If-Match ヘッダが未指定',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface CakeRouterDeps {
  // POST /v1/cakes・PATCH /v1/cakes/{id} の前に挟むミドルウェア配列（認証 + admin 強制）。
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

  // GET /{id} は認証不要。adminGuard を貼る前に登録することで public のまま保つ
  //（Hono は .use() の登録順でミドルウェア適用範囲が決まるため、順序が重要）。
  router.openapi(getCakeByIdRoute, async (c) => {
    const controller = c.get('modules').cakes;
    const { id } = c.req.valid('param');
    const { body, etag } = await controller.getById(id);
    c.header('ETag', etag);
    return c.json(body, 200);
  });

  router.use(createCakeRoute.getRoutingPath(), ...deps.adminGuard);
  router.openapi(createCakeRoute, async (c) => {
    const controller = c.get('modules').cakes;
    const input = c.req.valid('json');
    const body = await controller.create(input);
    return c.json(body, 201);
  });

  // PATCH /{id}（在庫更新）は管理者専用。adminGuard を /{id} パスにも貼ってから登録する。
  // If-Match は OpenAPI では検証任意（欠落時の 428 は controller で能動的に投げる）。
  router.use(updateCakeStockRoute.getRoutingPath(), ...deps.adminGuard);
  router.openapi(updateCakeStockRoute, async (c) => {
    const controller = c.get('modules').cakes;
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const { body, etag } = await controller.updateStock(id, c.req.header('If-Match'), input);
    c.header('ETag', etag);
    return c.json(body, 200);
  });

  return router;
};
