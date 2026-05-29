import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { RateLimitMiddlewares } from '@/app';
import { restrictToMethods } from '@/shared/http/rate-limit.middleware';
import { UnauthorizedError } from '@/shared/domain/errors';
import {
  ErrorResponseSchema,
  ListShopReviewsQuerySchema,
  ListShopReviewsResponseSchema,
  PostShopReviewRequestSchema,
  ShopReviewResponseSchema,
} from './shop-review.dto';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/reviews' にする — このルーターは app.ts 側で
//   `app.route('/v1/shop', ...)` でマウントされる（単一店舗なので path パラメータ無し）。
//
//   - GET  /v1/shop/reviews … 認証不要（口コミは誰でも読める）
//   - POST /v1/shop/reviews … 認証 + Idempotency-Key 必須
//
//   controller はリクエストごとに c.get('modules').shopReviews から取得する。
// ---------------------------------------------------------------------------

const listShopReviewsRoute = createRoute({
  method: 'get',
  path: '/reviews',
  tags: ['shop-reviews'],
  summary: '店舗のレビュー一覧を取得する（カーソルページネーション + 集計）',
  description:
    '店舗の published レビューを返す（認証不要）。1 ページ分のレビューに加え、' +
    'count / average / 星別 distribution（stats）を同梱する。' +
    'limit（既定 20・最大 100）で 1 ページ件数を指定し、next_cursor を after に渡して次ページへ進む。' +
    "sort は 'newest'（既定）または 'helpful'。after を付けて取得する際は、カーソル発行時と" +
    '同じ sort でなければ 400。filter_rating（1〜5）/ verified_only=true で絞り込み可能。',
  request: {
    query: ListShopReviewsQuerySchema,
  },
  responses: {
    200: {
      description: 'レビュー一覧（1 ページ分 + ページネーションメタ + 集計）',
      content: { 'application/json': { schema: ListShopReviewsResponseSchema } },
    },
    400: {
      description: 'limit / filter_rating が不正、または after カーソルが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const postShopReviewRoute = createRoute({
  method: 'post',
  path: '/reviews',
  tags: ['shop-reviews'],
  summary: '店舗にレビューを投稿する',
  description:
    '認証ユーザー本人が店舗へレビューを投稿する。' +
    '同一 user が published / hidden の店舗レビューを既に持っている場合は 409。' +
    '投稿時点で利用実績（PLACED 注文）があれば is_verified_customer=true として snapshot される。' +
    'POST は Idempotency-Key ヘッダ必須（再送による二重投稿を防ぐ）。',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: PostShopReviewRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成されたレビュー',
      content: { 'application/json': { schema: ShopReviewResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータが不正（Idempotency-Key 形式不正など）',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: '同じユーザーが店舗に対して既にレビューを投稿している',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: '同じ Idempotency-Key で異なる body が送られた',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface ShopReviewRouterDeps {
  // POST /reviews の前に挟む認証ガード（fakeAuth 経路も同じ shape）。
  authGuard: MiddlewareHandler<AppEnv>[];
  // Phase 10 Step 5: Rate Limit middleware。未指定なら何も適用しない（テスト最小経路）。
  rateLimits?: RateLimitMiddlewares;
  // Phase 10 Step 6: POST /reviews に貼る Idempotency middleware。
  //   未指定なら適用しない（テスト最小経路 / Supabase 未接続）。
  idempotency?: MiddlewareHandler<AppEnv>;
}

export const createShopReviewRouter = (deps: ShopReviewRouterDeps): OpenAPIHono<AppEnv> => {
  const router = createOpenAPIHono();
  const rl = deps.rateLimits;
  const reviewsPath = listShopReviewsRoute.getRoutingPath(); // '/reviews'

  // ----- Rate Limit / 認証の貼り方（cake レビューと同じパターン）-----
  //   GET / POST が同じパス '/reviews' を共有するため、restrictToMethods でメソッドを絞り、
  //   外側メソッドは limiter を呼ばずに素通しする。
  //
  //   登録順:
  //     1) rate-limit（GET → publicRead）
  //     2) GET handler 登録
  //     3) authGuard（POST のみ）
  //     4) rate-limit（POST → authWrite）
  //     5) idempotency（POST のみ）
  //     6) POST handler 登録

  if (rl) router.use(reviewsPath, restrictToMethods(['GET'], rl.publicRead));
  router.openapi(listShopReviewsRoute, async (c) => {
    const controller = c.get('modules').shopReviews;
    const query = c.req.valid('query');
    const body = await controller.list(query);

    // RFC 5988 Link ヘッダで次ページ URL を提示する（body の next_cursor と二重提供）。
    if (body.next_cursor) {
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set('limit', String(query.limit));
      nextUrl.searchParams.set('after', body.next_cursor);
      c.header('Link', `<${nextUrl.toString()}>; rel="next"`);
    }

    return c.json(body, 200);
  });

  // POST 固有のミドルウェア（authGuard + authWrite + idempotency）を
  // restrictToMethods で POST だけに絞ることで、GET を anonymous に保つ。
  for (const mw of deps.authGuard) {
    router.use(reviewsPath, restrictToMethods(['POST'], mw));
  }
  if (rl) router.use(reviewsPath, restrictToMethods(['POST'], rl.authWrite));
  if (deps.idempotency) router.use(reviewsPath, restrictToMethods(['POST'], deps.idempotency));

  router.openapi(postShopReviewRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証情報が取得できませんでした');
    }
    const controller = c.get('modules').shopReviews;
    const input = c.req.valid('json');
    const body = await controller.post(user.id, input);
    return c.json(body, 201);
  });

  return router;
};
