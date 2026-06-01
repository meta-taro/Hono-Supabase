import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '@/app';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { NoopEventPublisher } from '@/shared/application/event-publisher';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createGetCakeUseCase } from '@/modules/cakes/application/get-cake.usecase';
import { createUpdateCakeStockUseCase } from '@/modules/cakes/application/update-cake-stock.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { InMemoryCakeRepository } from '@/modules/cakes/application/__test-helpers__/in-memory-cake.repository';
import { createListCustomersUseCase } from '@/modules/customers/application/list-customers.usecase';
import { createSignUpCustomerUseCase } from '@/modules/customers/application/sign-up-customer.usecase';
import { createCustomerController } from '@/modules/customers/presentation/customer.controller';
import { InMemoryCustomerRepository } from '@/modules/customers/application/__test-helpers__/in-memory-customer.repository';
import { FakeCustomerAuth } from '@/modules/customers/application/__test-helpers__/fake-customer-auth';
import { createPlaceOrderUseCase } from '@/modules/orders/application/place-order.usecase';
import { createGetOrderUseCase } from '@/modules/orders/application/get-order.usecase';
import { createListOrdersUseCase } from '@/modules/orders/application/list-orders.usecase';
import { createOrderController } from '@/modules/orders/presentation/order.controller';
import { InMemoryOrderRepository } from '@/modules/orders/application/__test-helpers__/in-memory-order.repository';
import { createRegisterSubscriptionUseCase } from '@/modules/webhooks/application/register-subscription.usecase';
import { createListSubscriptionsUseCase } from '@/modules/webhooks/application/list-subscriptions.usecase';
import { createDeleteSubscriptionUseCase } from '@/modules/webhooks/application/delete-subscription.usecase';
import { createListDeliveriesUseCase } from '@/modules/webhooks/application/list-deliveries.usecase';
import { createWebhookController } from '@/modules/webhooks/presentation/webhook.controller';
import { InMemoryWebhookSubscriptionRepository } from '@/modules/webhooks/application/__test-helpers__/in-memory-webhook-subscription.repository';
import { InMemoryWebhookDeliveryRepository } from '@/modules/webhooks/application/__test-helpers__/in-memory-webhook-delivery.repository';
import { createPostReviewUseCase } from '@/modules/reviews/application/post-review.usecase';
import { createListReviewsByCakeUseCase } from '@/modules/reviews/application/list-reviews-by-cake.usecase';
import { createVoteReviewHelpfulUseCase } from '@/modules/reviews/application/vote-review-helpful.usecase';
import { createRemoveReviewHelpfulUseCase } from '@/modules/reviews/application/remove-review-helpful.usecase';
import { createReviewController } from '@/modules/reviews/presentation/review.controller';
import { InMemoryReviewRepository } from '@/modules/reviews/application/__test-helpers__/in-memory-review.repository';
import { InMemoryVerifiedPurchaserChecker } from '@/modules/reviews/application/__test-helpers__/in-memory-verified-purchaser.checker';
import { InMemoryReviewHelpfulVoteRepository } from '@/modules/reviews/application/__test-helpers__/in-memory-review-helpful-vote.repository';
import { createPostShopReviewUseCase } from '@/modules/reviews/application/post-shop-review.usecase';
import { createListShopReviewsUseCase } from '@/modules/reviews/application/list-shop-reviews.usecase';
import { createVoteShopReviewHelpfulUseCase } from '@/modules/reviews/application/vote-shop-review-helpful.usecase';
import { createRemoveShopReviewHelpfulUseCase } from '@/modules/reviews/application/remove-shop-review-helpful.usecase';
import { createShopReviewController } from '@/modules/reviews/presentation/shop-review.controller';
import { InMemoryShopReviewRepository } from '@/modules/reviews/application/__test-helpers__/in-memory-shop-review.repository';
import { InMemoryOrderHistoryChecker } from '@/modules/reviews/application/__test-helpers__/in-memory-order-history.checker';
import { InMemoryShopReviewHelpfulVoteRepository } from '@/modules/reviews/application/__test-helpers__/in-memory-shop-review-helpful-vote.repository';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import { createFakeAuthMiddleware, requireAuth, requireAdmin } from '@/shared/http/auth.middleware';
import type { AppEnv, AuthUser, RequestModules } from '@/shared/http/request-context';

// ---------------------------------------------------------------------------
// Phase 11 Step 2: 店舗（単一店舗）レビューの統合テスト。
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   - GET  /v1/shop/reviews … 認証不要・カーソルページネーション・stats 同梱
//   - POST /v1/shop/reviews … 認証必須・409 / is_verified_customer snapshot
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は shop-review.supabase-repository.test.ts / supabase-order-history.
//   checker.test.ts で実 Supabase（has_ordered RPC 含む）に対して検証済み。
//   ここでは「HTTP → UseCase → Response」の経路と、店舗ルーターが /v1/shop に
//   マウントされても cake レビュー（/v1/cakes/:cake_id/reviews）と独立に動くことを
//   高速・決定的に確認する。
// ---------------------------------------------------------------------------

const silentLogger = createSilentLogger();

const AUTH_USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  role: 'authenticated',
};

const OTHER_USER: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'other@example.com',
  role: 'authenticated',
};

interface TestApp {
  app: ReturnType<typeof createApp>;
  shopReviewsRepo: InMemoryShopReviewRepository;
  orderHistoryChecker: InMemoryOrderHistoryChecker;
  voteRepo: InMemoryShopReviewHelpfulVoteRepository;
}

const buildTestApp = (params: { user?: AuthUser | null } = {}): TestApp => {
  const customersRepo = new InMemoryCustomerRepository();
  const customerAuth = new FakeCustomerAuth(customersRepo);
  const customersController = createCustomerController({
    listCustomers: createListCustomersUseCase(customersRepo),
    signUpCustomer: createSignUpCustomerUseCase(customerAuth, customersRepo, silentLogger),
  });

  const cakesRepo = new InMemoryCakeRepository();
  const cakesController = createCakeController({
    listCakes: createListCakesUseCase(cakesRepo),
    createCake: createCreateCakeUseCase(cakesRepo, silentLogger),
    getCake: createGetCakeUseCase(cakesRepo),
    updateCakeStock: createUpdateCakeStockUseCase(cakesRepo, silentLogger),
  });

  const ordersRepo = new InMemoryOrderRepository();
  const ordersController = createOrderController({
    placeOrder: createPlaceOrderUseCase(ordersRepo, silentLogger, NoopEventPublisher),
    getOrder: createGetOrderUseCase(ordersRepo),
    listOrders: createListOrdersUseCase(ordersRepo),
    resolveCustomerId: async (authUserId) => {
      const c = await customersRepo.findByAuthUserId(authUserId);
      return c?.id.value ?? null;
    },
  });

  const webhookSubRepo = new InMemoryWebhookSubscriptionRepository();
  const webhookDelRepo = new InMemoryWebhookDeliveryRepository();
  const webhooksController = createWebhookController({
    registerSubscription: createRegisterSubscriptionUseCase(webhookSubRepo, silentLogger),
    listSubscriptions: createListSubscriptionsUseCase(webhookSubRepo),
    deleteSubscription: createDeleteSubscriptionUseCase(webhookSubRepo, silentLogger),
    listDeliveries: createListDeliveriesUseCase(webhookSubRepo, webhookDelRepo),
  });

  const reviewsRepo = new InMemoryReviewRepository();
  const verifiedChecker = new InMemoryVerifiedPurchaserChecker();
  const reviewVoteRepo = new InMemoryReviewHelpfulVoteRepository();
  const reviewsController = createReviewController({
    postReview: createPostReviewUseCase(reviewsRepo, verifiedChecker, silentLogger),
    listReviewsByCake: createListReviewsByCakeUseCase(reviewsRepo),
    voteHelpful: createVoteReviewHelpfulUseCase(reviewsRepo, reviewVoteRepo, silentLogger),
    removeHelpful: createRemoveReviewHelpfulUseCase(reviewsRepo, reviewVoteRepo, silentLogger),
  });

  const shopReviewsRepo = new InMemoryShopReviewRepository();
  const orderHistoryChecker = new InMemoryOrderHistoryChecker();
  const voteRepo = new InMemoryShopReviewHelpfulVoteRepository();
  const shopReviewsController = createShopReviewController({
    postShopReview: createPostShopReviewUseCase(shopReviewsRepo, orderHistoryChecker, silentLogger),
    listShopReviews: createListShopReviewsUseCase(shopReviewsRepo),
    voteShopReviewHelpful: createVoteShopReviewHelpfulUseCase(
      shopReviewsRepo,
      voteRepo,
      silentLogger,
    ),
    removeShopReviewHelpful: createRemoveShopReviewHelpfulUseCase(
      shopReviewsRepo,
      voteRepo,
      silentLogger,
    ),
  });

  const modules: RequestModules = {
    cakes: cakesController,
    customers: customersController,
    orders: ordersController,
    webhooks: webhooksController,
    reviews: reviewsController,
    shopReviews: shopReviewsController,
  };

  const stubSb = null as unknown as SupabaseClient;
  const fakeModulesMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set('sb', stubSb);
    c.set('modules', modules);
    await next();
  };

  const app = createApp({
    rootMiddlewares: [createFakeAuthMiddleware(params.user ?? null), fakeModulesMiddleware],
    guards: {
      adminGuard: [requireAuth(), requireAdmin()],
      authGuard: [requireAuth()],
    },
  });

  return { app, shopReviewsRepo, orderHistoryChecker, voteRepo };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// テスト用 fixture: ShopReview.create を呼び、createdAt / helpfulCount / status を
// 差し替えたい場合は reconstruct で組み直して返す（in-memory リポジトリの sort / filter
// 検証で時系列や状態を制御するため）。
const buildShopReview = (params: {
  userId: string;
  rating: number;
  title?: string;
  body?: string;
  isVerifiedCustomer?: boolean;
  status?: 'published' | 'hidden' | 'removed';
  createdAt?: Date;
  helpfulCount?: number;
}): ShopReview => {
  const review = ShopReview.create({
    userId: params.userId,
    rating: params.rating,
    title: params.title ?? 'good',
    body: params.body ?? 'tasty',
    isVerifiedCustomer: params.isVerifiedCustomer ?? false,
  });
  if (
    params.createdAt !== undefined ||
    params.helpfulCount !== undefined ||
    params.status !== undefined
  ) {
    return ShopReview.reconstruct({
      id: review.id.value,
      userId: review.userId,
      rating: review.rating.value,
      title: review.title,
      body: review.body,
      status: params.status ?? review.status,
      isVerifiedCustomer: review.isVerifiedCustomer,
      helpfulCount: params.helpfulCount ?? review.helpfulCount,
      flagCount: 0,
      createdAt: params.createdAt ?? review.createdAt,
      updatedAt: review.updatedAt,
    });
  }
  return review;
};

describe('GET /v1/shop/reviews（認証不要）', () => {
  it('レビューが 1 件もない場合 200 + 空配列 + count=0/average=null を返す', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/shop/reviews');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: unknown[];
      next_cursor: string | null;
      has_more: boolean;
      stats: { count: number; average: number | null; distribution: Record<string, number> };
    };
    expect(body.reviews).toEqual([]);
    expect(body.next_cursor).toBeNull();
    expect(body.has_more).toBe(false);
    expect(body.stats.count).toBe(0);
    expect(body.stats.average).toBeNull();
    expect(body.stats.distribution).toEqual({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });
  });

  it('published レビューだけを返し、stats も計算される', async () => {
    const { app, shopReviewsRepo } = buildTestApp();
    shopReviewsRepo.preload([
      buildShopReview({ userId: 'u1', rating: 5 }),
      buildShopReview({ userId: 'u2', rating: 4 }),
      buildShopReview({ userId: 'u3', rating: 3 }),
      // hidden / removed は一覧にも stats にも含めない
      buildShopReview({ userId: 'u4', rating: 1, status: 'hidden' }),
      buildShopReview({ userId: 'u5', rating: 1, status: 'removed' }),
    ]);

    const res = await app.request('/v1/shop/reviews');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ user_id: string; rating: number }>;
      stats: { count: number; average: number | null; distribution: Record<string, number> };
    };
    expect(body.reviews).toHaveLength(3);
    expect(body.stats.count).toBe(3);
    // 平均 (5+4+3)/3 = 4
    expect(body.stats.average).toBe(4);
    expect(body.stats.distribution).toEqual({ '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 });
  });

  it('sort=newest（既定）で created_at の降順に並ぶ', async () => {
    const { app, shopReviewsRepo } = buildTestApp();
    shopReviewsRepo.preload([
      buildShopReview({
        userId: 'u-old',
        rating: 5,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      buildShopReview({
        userId: 'u-mid',
        rating: 3,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      buildShopReview({
        userId: 'u-new',
        rating: 4,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    ]);

    const res = await app.request('/v1/shop/reviews');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviews: Array<{ user_id: string }> };
    expect(body.reviews.map((r) => r.user_id)).toEqual(['u-new', 'u-mid', 'u-old']);
  });

  it('sort=helpful で helpful_count の降順に並ぶ', async () => {
    const { app, shopReviewsRepo } = buildTestApp();
    shopReviewsRepo.preload([
      buildShopReview({ userId: 'u-a', rating: 5, helpfulCount: 1 }),
      buildShopReview({ userId: 'u-b', rating: 5, helpfulCount: 10 }),
      buildShopReview({ userId: 'u-c', rating: 5, helpfulCount: 5 }),
    ]);

    const res = await app.request('/v1/shop/reviews?sort=helpful');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ user_id: string; helpful_count: number }>;
    };
    expect(body.reviews.map((r) => r.user_id)).toEqual(['u-b', 'u-c', 'u-a']);
    expect(body.reviews.map((r) => r.helpful_count)).toEqual([10, 5, 1]);
  });

  it('filter_rating で星評価による絞り込みができる（stats は全件ベース）', async () => {
    const { app, shopReviewsRepo } = buildTestApp();
    shopReviewsRepo.preload([
      buildShopReview({ userId: 'u1', rating: 5 }),
      buildShopReview({ userId: 'u2', rating: 5 }),
      buildShopReview({ userId: 'u3', rating: 3 }),
    ]);

    const res = await app.request('/v1/shop/reviews?filter_rating=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ rating: number }>;
      stats: { count: number };
    };
    expect(body.reviews).toHaveLength(2);
    expect(body.reviews.every((r) => r.rating === 5)).toBe(true);
    // stats は filter 適用前の全件
    expect(body.stats.count).toBe(3);
  });

  it('verified_only=true で利用実績バッジ付きだけに絞れる', async () => {
    const { app, shopReviewsRepo } = buildTestApp();
    shopReviewsRepo.preload([
      buildShopReview({ userId: 'u-verified', rating: 5, isVerifiedCustomer: true }),
      buildShopReview({ userId: 'u-unverified', rating: 4, isVerifiedCustomer: false }),
    ]);

    const res = await app.request('/v1/shop/reviews?verified_only=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ user_id: string; is_verified_customer: boolean }>;
    };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]?.user_id).toBe('u-verified');
    expect(body.reviews[0]?.is_verified_customer).toBe(true);
  });

  describe('カーソルページネーション', () => {
    it('limit で分割し、next_cursor を after に渡して続きが取得できる', async () => {
      const { app, shopReviewsRepo } = buildTestApp();
      shopReviewsRepo.preload([
        buildShopReview({
          userId: 'u-old',
          rating: 5,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        buildShopReview({
          userId: 'u-mid',
          rating: 4,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        }),
        buildShopReview({
          userId: 'u-new',
          rating: 3,
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ]);

      const res1 = await app.request('/v1/shop/reviews?limit=2');
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        reviews: Array<{ user_id: string }>;
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(body1.reviews.map((r) => r.user_id)).toEqual(['u-new', 'u-mid']);
      expect(body1.has_more).toBe(true);
      expect(body1.next_cursor).not.toBeNull();

      const res2 = await app.request(
        `/v1/shop/reviews?limit=2&after=${encodeURIComponent(body1.next_cursor as string)}`,
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        reviews: Array<{ user_id: string }>;
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(body2.reviews.map((r) => r.user_id)).toEqual(['u-old']);
      expect(body2.has_more).toBe(false);
      expect(body2.next_cursor).toBeNull();
    });

    it('カーソル発行時の sort と異なる sort を指定すると 400 VALIDATION_ERROR を返す', async () => {
      const { app, shopReviewsRepo } = buildTestApp();
      shopReviewsRepo.preload([
        buildShopReview({
          userId: 'u1',
          rating: 5,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        buildShopReview({
          userId: 'u2',
          rating: 4,
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ]);

      const res1 = await app.request('/v1/shop/reviews?sort=newest&limit=1');
      const body1 = (await res1.json()) as { next_cursor: string | null };
      expect(body1.next_cursor).not.toBeNull();

      const res2 = await app.request(
        `/v1/shop/reviews?sort=helpful&limit=1&after=${encodeURIComponent(
          body1.next_cursor as string,
        )}`,
      );
      expect(res2.status).toBe(400);
      const body2 = (await res2.json()) as { error: { code: string } };
      expect(body2.error.code).toBe('VALIDATION_ERROR');
    });

    it('改竄カーソルは 400 VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp();
      const res = await app.request('/v1/shop/reviews?after=not-a-valid-cursor');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('POST /v1/shop/reviews（要認証）', () => {
  it('201 と作成されたレビューを返す（利用実績が無ければ is_verified_customer=false）', async () => {
    const { app, shopReviewsRepo } = buildTestApp({ user: AUTH_USER });

    const res = await app.request('/v1/shop/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rating: 5,
        title: '雰囲気が良いお店',
        body: '店員さんの対応も丁寧でした。',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      user_id: string;
      rating: number;
      title: string;
      body: string;
      is_verified_customer: boolean;
      helpful_count: number;
      created_at: string;
    };
    expect(body.id).toMatch(UUID_REGEX);
    expect(body.user_id).toBe(AUTH_USER.id);
    expect(body.rating).toBe(5);
    expect(body.title).toBe('雰囲気が良いお店');
    expect(body.is_verified_customer).toBe(false);
    expect(body.helpful_count).toBe(0);
    // 単一店舗なので cake_id は存在しない
    expect(body).not.toHaveProperty('cake_id');
    // 永続化されている
    const stats = await shopReviewsRepo.stats();
    expect(stats.count).toBe(1);
  });

  it('利用実績があれば is_verified_customer=true で snapshot される', async () => {
    const { app, orderHistoryChecker } = buildTestApp({ user: AUTH_USER });
    orderHistoryChecker.markOrdered(AUTH_USER.id);

    const res = await app.request('/v1/shop/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 4, title: 'good', body: 'ok' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { is_verified_customer: boolean };
    expect(body.is_verified_customer).toBe(true);
  });

  describe('認証ガード', () => {
    it('未認証だと 401 + UNAUTHORIZED を返し、レビューは作成されない', async () => {
      const { app, shopReviewsRepo } = buildTestApp({ user: null });

      const res = await app.request('/v1/shop/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 5, title: 't', body: 'b' }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      const stats = await shopReviewsRepo.stats();
      expect(stats.count).toBe(0);
    });
  });

  describe('業務エラー', () => {
    it('同じユーザーが店舗に 2 回投稿すると 409 CONFLICT を返す', async () => {
      const { app, shopReviewsRepo } = buildTestApp({ user: AUTH_USER });
      shopReviewsRepo.preload([buildShopReview({ userId: AUTH_USER.id, rating: 5 })]);

      const res = await app.request('/v1/shop/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 4, title: 't', body: 'b' }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CONFLICT');
    });

    it('別ユーザーは店舗に投稿できる', async () => {
      const { app, shopReviewsRepo } = buildTestApp({ user: OTHER_USER });
      shopReviewsRepo.preload([buildShopReview({ userId: AUTH_USER.id, rating: 5 })]);

      const res = await app.request('/v1/shop/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 3, title: 't', body: 'b' }),
      });

      expect(res.status).toBe(201);
    });
  });

  describe('入力バリデーション', () => {
    it('rating が 1〜5 の範囲外なら 400 VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp({ user: AUTH_USER });

      const res = await app.request('/v1/shop/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 6, title: 't', body: 'b' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('title が空なら 400 VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp({ user: AUTH_USER });

      const res = await app.request('/v1/shop/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 5, title: '', body: 'b' }),
      });

      expect(res.status).toBe(400);
    });
  });
});

describe('POST /v1/shop/reviews/:review_id/helpful（要認証・トグル）', () => {
  it('200 + helpful_count=1 / voted=true を返し、投票が記録される', async () => {
    const { app, shopReviewsRepo, voteRepo } = buildTestApp({ user: OTHER_USER });
    // 投稿者は AUTH_USER。投票者は OTHER_USER（他人なので付与できる）。
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    const res = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_id: string;
      helpful_count: number;
      voted: boolean;
    };
    expect(body.review_id).toBe(review.id.value);
    expect(body.helpful_count).toBe(1);
    expect(body.voted).toBe(true);
    expect(voteRepo.has(review.id, OTHER_USER.id)).toBe(true);
  });

  it('同じユーザーが 2 回 POST しても冪等（helpful_count=1 のまま）', async () => {
    const { app, shopReviewsRepo } = buildTestApp({ user: OTHER_USER });
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, { method: 'POST' });
    const res2 = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'POST',
    });

    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { helpful_count: number; voted: boolean };
    expect(body.helpful_count).toBe(1);
    expect(body.voted).toBe(true);
  });

  it('自分のレビューには投票できず 403 FORBIDDEN を返す', async () => {
    const { app, shopReviewsRepo, voteRepo } = buildTestApp({ user: AUTH_USER });
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    const res = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(voteRepo.has(review.id, AUTH_USER.id)).toBe(false);
  });

  it('未認証だと 401 UNAUTHORIZED を返す', async () => {
    const { app, shopReviewsRepo } = buildTestApp({ user: null });
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    const res = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'POST',
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('対象レビューが存在しなければ 404 NOT_FOUND を返す', async () => {
    const { app } = buildTestApp({ user: OTHER_USER });
    const missingReviewId = randomUUID();

    const res = await app.request(`/v1/shop/reviews/${missingReviewId}/helpful`, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('review_id が UUID でなければ 400 VALIDATION_ERROR を返す', async () => {
    const { app } = buildTestApp({ user: OTHER_USER });

    const res = await app.request('/v1/shop/reviews/not-a-uuid/helpful', { method: 'POST' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /v1/shop/reviews/:review_id/helpful（要認証・トグル取消）', () => {
  it('付与済みの投票を取り消すと 200 + helpful_count=0 / voted=false を返す', async () => {
    const { app, shopReviewsRepo, voteRepo } = buildTestApp({ user: OTHER_USER });
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, { method: 'POST' });
    expect(voteRepo.has(review.id, OTHER_USER.id)).toBe(true);

    const res = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { helpful_count: number; voted: boolean };
    expect(body.helpful_count).toBe(0);
    expect(body.voted).toBe(false);
    expect(voteRepo.has(review.id, OTHER_USER.id)).toBe(false);
  });

  it('未投票の状態で DELETE しても冪等（200 + helpful_count=0 / voted=false）', async () => {
    const { app, shopReviewsRepo } = buildTestApp({ user: OTHER_USER });
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    const res = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { helpful_count: number; voted: boolean };
    expect(body.helpful_count).toBe(0);
    expect(body.voted).toBe(false);
  });

  it('未認証だと 401 UNAUTHORIZED を返す', async () => {
    const { app, shopReviewsRepo } = buildTestApp({ user: null });
    const review = buildShopReview({ userId: AUTH_USER.id, rating: 5 });
    shopReviewsRepo.preload([review]);

    const res = await app.request(`/v1/shop/reviews/${review.id.value}/helpful`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(401);
  });
});

describe('shop レビューと cake レビューの独立性', () => {
  it('店舗レビューを投稿しても cake レビュー一覧には現れない', async () => {
    const { app } = buildTestApp({ user: AUTH_USER });

    const postRes = await app.request('/v1/shop/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 5, title: 't', body: 'b' }),
    });
    expect(postRes.status).toBe(201);

    // 店舗一覧には 1 件
    const shopRes = await app.request('/v1/shop/reviews');
    const shopBody = (await shopRes.json()) as { reviews: unknown[] };
    expect(shopBody.reviews).toHaveLength(1);

    // 任意のケーキ一覧には現れない（別 Aggregate / 別テーブル）
    const cakeRes = await app.request(`/v1/cakes/${randomUUID()}/reviews`);
    expect(cakeRes.status).toBe(200);
    const cakeBody = (await cakeRes.json()) as { reviews: unknown[]; stats: { count: number } };
    expect(cakeBody.reviews).toHaveLength(0);
    expect(cakeBody.stats.count).toBe(0);
  });
});
