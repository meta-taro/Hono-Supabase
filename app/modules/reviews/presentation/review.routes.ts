import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { RateLimitMiddlewares } from '@/app';
import { restrictToMethods } from '@/shared/http/rate-limit.middleware';
import { UnauthorizedError } from '@/shared/domain/errors';
import {
  CakeIdPathParamSchema,
  CakeReviewVotePathParamSchema,
  ErrorResponseSchema,
  HelpfulVoteResponseSchema,
  ListReviewsQuerySchema,
  ListReviewsResponseSchema,
  PostReviewRequestSchema,
  ReviewResponseSchema,
} from './review.dto';

// ---------------------------------------------------------------------------
// Route 定義
//   path は '/{cake_id}/reviews' にする — このルーターは app.ts 側で
//   `app.route('/v1/cakes', ...)` でマウントされ、cake router と同じプレフィックスを
//   共有する（Hono は trie で OpenAPI ルートを区別するため衝突しない）。
//
//   - GET  /v1/cakes/{cake_id}/reviews … 認証不要（口コミは誰でも読める）
//   - POST /v1/cakes/{cake_id}/reviews … 認証 + Idempotency-Key 必須
//
//   controller はリクエストごとに c.get('modules').reviews から取得する。
// ---------------------------------------------------------------------------

const listReviewsRoute = createRoute({
  method: 'get',
  path: '/{cake_id}/reviews',
  tags: ['reviews'],
  summary: 'ケーキのレビュー一覧を取得する（カーソルページネーション + 集計）',
  description:
    '対象ケーキの published レビューを返す（認証不要）。1 ページ分のレビューに加え、' +
    'count / average / 星別 distribution（stats）を同梱する。' +
    'limit（既定 20・最大 100）で 1 ページ件数を指定し、next_cursor を after に渡して次ページへ進む。' +
    "sort は 'newest'（既定）または 'helpful'。after を付けて取得する際は、カーソル発行時と" +
    '同じ sort でなければ 400。filter_rating（1〜5）/ verified_only=true で絞り込み可能。',
  request: {
    params: CakeIdPathParamSchema,
    query: ListReviewsQuerySchema,
  },
  responses: {
    200: {
      description: 'レビュー一覧（1 ページ分 + ページネーションメタ + 集計）',
      content: { 'application/json': { schema: ListReviewsResponseSchema } },
    },
    400: {
      description: 'limit / filter_rating / cake_id が不正、または after カーソルが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const postReviewRoute = createRoute({
  method: 'post',
  path: '/{cake_id}/reviews',
  tags: ['reviews'],
  summary: 'ケーキにレビューを投稿する',
  description:
    '認証ユーザー本人が対象ケーキへレビューを投稿する。' +
    '同一 user が同一 cake に対し published / hidden のレビューを既に持っている場合は 409。' +
    '投稿時点で当該 cake を購入済みであれば is_verified_purchaser=true として snapshot される。' +
    'POST は Idempotency-Key ヘッダ必須（再送による二重投稿を防ぐ）。',
  security: [{ bearerAuth: [] }],
  request: {
    params: CakeIdPathParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: PostReviewRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成されたレビュー',
      content: { 'application/json': { schema: ReviewResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータが不正（cake_id 不正 / Idempotency-Key 形式不正など）',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: '同じユーザーが同じケーキに対して既にレビューを投稿している',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: '同じ Idempotency-Key で異なる body が送られた',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// 「役立った」投票（Phase 11 Step 3）
//   - POST   /v1/cakes/{cake_id}/reviews/{review_id}/helpful … 付与（冪等）
//   - DELETE /v1/cakes/{cake_id}/reviews/{review_id}/helpful … 取消（冪等）
//   いずれも認証必須。トグルが UNIQUE(user_id, review_id) + INSERT ON CONFLICT DO NOTHING /
//   DELETE no-op で自然に冪等なので、Idempotency-Key は不要（authWrite rate limit のみ）。
//   自己投票は 403（付与時のみ）。対象が無い / published でなければ 404。
// ---------------------------------------------------------------------------

const voteHelpfulRoute = createRoute({
  method: 'post',
  path: '/{cake_id}/reviews/{review_id}/helpful',
  tags: ['reviews'],
  summary: 'レビューに「役立った」を付ける',
  description:
    '認証ユーザーが対象レビューに「役立った」を付与する。既に付与済みなら no-op（冪等）。' +
    '自分のレビューには付けられない（403）。反映後の helpful_count と自分の投票状態を返す。',
  security: [{ bearerAuth: [] }],
  request: {
    params: CakeReviewVotePathParamSchema,
  },
  responses: {
    200: {
      description: '付与後の投票数と自分の投票状態',
      content: { 'application/json': { schema: HelpfulVoteResponseSchema } },
    },
    400: {
      description: 'cake_id / review_id が UUID でない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: '自分のレビューには「役立った」を付けられない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: '対象レビューが存在しない、または published でない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const removeHelpfulRoute = createRoute({
  method: 'delete',
  path: '/{cake_id}/reviews/{review_id}/helpful',
  tags: ['reviews'],
  summary: 'レビューの「役立った」を取り消す',
  description:
    '認証ユーザーが付与済みの「役立った」を取消する。未投票なら no-op（冪等）。' +
    '反映後の helpful_count と自分の投票状態（voted=false）を返す。',
  security: [{ bearerAuth: [] }],
  request: {
    params: CakeReviewVotePathParamSchema,
  },
  responses: {
    200: {
      description: '取消後の投票数と自分の投票状態',
      content: { 'application/json': { schema: HelpfulVoteResponseSchema } },
    },
    400: {
      description: 'cake_id / review_id が UUID でない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: '未認証',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: '対象レビューが存在しない、または published でない',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface ReviewRouterDeps {
  // POST /{cake_id}/reviews の前に挟む認証ガード（fakeAuth 経路も同じ shape）。
  authGuard: MiddlewareHandler<AppEnv>[];
  // Phase 10 Step 5: Rate Limit middleware。未指定なら何も適用しない（テスト最小経路）。
  rateLimits?: RateLimitMiddlewares;
  // Phase 10 Step 6: POST /{cake_id}/reviews に貼る Idempotency middleware。
  //   未指定なら適用しない（テスト最小経路 / Supabase 未接続）。
  idempotency?: MiddlewareHandler<AppEnv>;
}

export const createReviewRouter = (deps: ReviewRouterDeps): OpenAPIHono<AppEnv> => {
  const router = createOpenAPIHono();
  const rl = deps.rateLimits;
  const reviewsPath = listReviewsRoute.getRoutingPath(); // '/:cake_id/reviews'

  // ----- Rate Limit / 認証の貼り方 -----
  //   GET / POST が同じパス '/{cake_id}/reviews' を共有するため、
  //   restrictToMethods でメソッドを絞り、外側メソッドは limiter を呼ばずに素通しする
  //   （cakes / orders で確立済みのパターン）。
  //
  //   登録順:
  //     1) rate-limit（GET → publicRead）          ← GET は登録順で先
  //     2) GET handler 登録
  //     3) authGuard（POST のみ）
  //     4) rate-limit（POST → authWrite）
  //     5) idempotency（POST のみ）
  //     6) POST handler 登録

  if (rl) router.use(reviewsPath, restrictToMethods(['GET'], rl.publicRead));
  router.openapi(listReviewsRoute, async (c) => {
    const controller = c.get('modules').reviews;
    const { cake_id: cakeId } = c.req.valid('param');
    const query = c.req.valid('query');
    const body = await controller.list(cakeId, query);

    // RFC 5988 Link ヘッダで次ページ URL を提示する（body の next_cursor と二重提供）。
    if (body.next_cursor) {
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set('limit', String(query.limit));
      nextUrl.searchParams.set('after', body.next_cursor);
      c.header('Link', `<${nextUrl.toString()}>; rel="next"`);
    }

    return c.json(body, 200);
  });

  // POST のみ authGuard を貼る（GET は anonymous のままにする）。
  // restrictToMethods は rate-limit / idempotency 専用のヘルパなので、
  // 認証ガードは「POST handler 内」で c.get('user') を取り出して未認証なら 401 を投げる
  // — のではなく、ルーターレベルで GET と POST を別パスに分ける必要がある。
  // ただし Hono は同じ string path で複数 method の handler を共存させ、
  // .use(path, mw) は path にマッチするすべての method に適用される。
  // ここでは「POST 固有のミドルウェア（authGuard + authWrite + idempotency）」を
  // restrictToMethods で POST だけに絞ることで、GET を anonymous に保つ。
  for (const mw of deps.authGuard) {
    router.use(reviewsPath, restrictToMethods(['POST'], mw));
  }
  if (rl) router.use(reviewsPath, restrictToMethods(['POST'], rl.authWrite));
  if (deps.idempotency) router.use(reviewsPath, restrictToMethods(['POST'], deps.idempotency));

  router.openapi(postReviewRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証情報が取得できませんでした');
    }
    const controller = c.get('modules').reviews;
    const { cake_id: cakeId } = c.req.valid('param');
    const input = c.req.valid('json');
    const body = await controller.post(cakeId, user.id, input);
    return c.json(body, 201);
  });

  // ----- 「役立った」投票（POST / DELETE .../helpful）-----
  //   reviews パスとは別 trie ノード（'/:cake_id/reviews/:review_id/helpful'）なので、
  //   上の reviewsPath に貼った middleware は波及しない。ここで独立に貼り直す。
  //   POST も DELETE も認証必須。冪等なので Idempotency-Key は貼らない（authWrite のみ）。
  const votePath = voteHelpfulRoute.getRoutingPath(); // '/:cake_id/reviews/:review_id/helpful'
  for (const mw of deps.authGuard) {
    router.use(votePath, restrictToMethods(['POST', 'DELETE'], mw));
  }
  if (rl) router.use(votePath, restrictToMethods(['POST', 'DELETE'], rl.authWrite));

  router.openapi(voteHelpfulRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証情報が取得できませんでした');
    }
    const controller = c.get('modules').reviews;
    const { review_id: reviewId } = c.req.valid('param');
    const body = await controller.voteHelpful(reviewId, user.id);
    return c.json(body, 200);
  });

  router.openapi(removeHelpfulRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証情報が取得できませんでした');
    }
    const controller = c.get('modules').reviews;
    const { review_id: reviewId } = c.req.valid('param');
    const body = await controller.removeHelpful(reviewId, user.id);
    return c.json(body, 200);
  });

  return router;
};
