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
import { createReviewController } from '@/modules/reviews/presentation/review.controller';
import { InMemoryReviewRepository } from '@/modules/reviews/application/__test-helpers__/in-memory-review.repository';
import { InMemoryVerifiedPurchaserChecker } from '@/modules/reviews/application/__test-helpers__/in-memory-verified-purchaser.checker';
import { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import { Review } from '@/modules/reviews/domain/review';
import { createFakeAuthMiddleware, requireAuth, requireAdmin } from '@/shared/http/auth.middleware';
import type { AppEnv, AuthUser, RequestModules } from '@/shared/http/request-context';

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   - GET  /v1/cakes/{cake_id}/reviews … 認証不要・カーソルページネーション・stats 同梱
//   - POST /v1/cakes/{cake_id}/reviews … 認証必須・409 / 422 / verified_purchaser snapshot
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は review.supabase-repository.test.ts で実 Supabase（has_purchased RPC
//   含む）に対して既に検証済み。ここでは「HTTP → UseCase → Response」の経路と、
//   reviews router が cakeRouter と同じ '/v1/cakes' プレフィックスにマウントされても
//   path が衝突しないことを高速・決定的に確認する。
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
  reviewsRepo: InMemoryReviewRepository;
  verifiedChecker: InMemoryVerifiedPurchaserChecker;
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
  const reviewsController = createReviewController({
    postReview: createPostReviewUseCase(reviewsRepo, verifiedChecker, silentLogger),
    listReviewsByCake: createListReviewsByCakeUseCase(reviewsRepo),
  });

  const modules: RequestModules = {
    cakes: cakesController,
    customers: customersController,
    orders: ordersController,
    webhooks: webhooksController,
    reviews: reviewsController,
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

  return { app, reviewsRepo, verifiedChecker };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// テスト用 fixture: Review.create を呼んで preload に突っ込める形で返す。
//   createdAt は in-memory リポジトリの sort 検証で時系列を確認するため、テスト側で
//   差し替えたいケースに備えて override 可能にする。
const buildReview = (params: {
  cakeId: string;
  userId: string;
  rating: number;
  title?: string;
  body?: string;
  isVerifiedPurchaser?: boolean;
  createdAt?: Date;
  helpfulCount?: number;
}): Review => {
  const review = Review.create({
    cakeId: CakeId.from(params.cakeId),
    userId: params.userId,
    rating: params.rating,
    title: params.title ?? 'good',
    body: params.body ?? 'tasty',
    isVerifiedPurchaser: params.isVerifiedPurchaser ?? false,
  });
  // createdAt / helpfulCount を反映したい場合は reconstruct で組み直す。
  if (params.createdAt !== undefined || params.helpfulCount !== undefined) {
    return Review.reconstruct({
      id: review.id.value,
      cakeId: review.cakeId.value,
      userId: review.userId,
      rating: review.rating.value,
      title: review.title,
      body: review.body,
      status: review.status,
      isVerifiedPurchaser: review.isVerifiedPurchaser,
      helpfulCount: params.helpfulCount ?? review.helpfulCount,
      flagCount: 0,
      createdAt: params.createdAt ?? review.createdAt,
      updatedAt: review.updatedAt,
    });
  }
  return review;
};

describe('GET /v1/cakes/:cake_id/reviews（認証不要）', () => {
  it('レビューが 1 件もない場合 200 + 空配列 + count=0/average=null を返す', async () => {
    const { app } = buildTestApp();
    const cakeId = randomUUID();

    const res = await app.request(`/v1/cakes/${cakeId}/reviews`);

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

  it('cake_id が UUID でなければ 400 VALIDATION_ERROR を返す', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/v1/cakes/not-a-uuid/reviews');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('対象 cake のレビューだけを返し、stats も計算される', async () => {
    const { app, reviewsRepo } = buildTestApp();
    const cakeA = randomUUID();
    const cakeB = randomUUID();
    reviewsRepo.preload([
      buildReview({ cakeId: cakeA, userId: 'u1', rating: 5 }),
      buildReview({ cakeId: cakeA, userId: 'u2', rating: 4 }),
      buildReview({ cakeId: cakeA, userId: 'u3', rating: 3 }),
      // 別ケーキ → 含まれない
      buildReview({ cakeId: cakeB, userId: 'u4', rating: 1 }),
    ]);

    const res = await app.request(`/v1/cakes/${cakeA}/reviews`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ cake_id: string; rating: number }>;
      stats: { count: number; average: number | null; distribution: Record<string, number> };
    };
    expect(body.reviews).toHaveLength(3);
    expect(body.reviews.every((r) => r.cake_id === cakeA)).toBe(true);
    expect(body.stats.count).toBe(3);
    // 平均 (5+4+3)/3 = 4
    expect(body.stats.average).toBe(4);
    expect(body.stats.distribution).toEqual({ '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 });
  });

  it('sort=newest（既定）で created_at の降順に並ぶ', async () => {
    const { app, reviewsRepo } = buildTestApp();
    const cakeId = randomUUID();
    reviewsRepo.preload([
      buildReview({
        cakeId,
        userId: 'u-old',
        rating: 5,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      buildReview({
        cakeId,
        userId: 'u-mid',
        rating: 3,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      buildReview({
        cakeId,
        userId: 'u-new',
        rating: 4,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    ]);

    const res = await app.request(`/v1/cakes/${cakeId}/reviews`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviews: Array<{ user_id: string }> };
    expect(body.reviews.map((r) => r.user_id)).toEqual(['u-new', 'u-mid', 'u-old']);
  });

  it('sort=helpful で helpful_count の降順に並ぶ', async () => {
    const { app, reviewsRepo } = buildTestApp();
    const cakeId = randomUUID();
    reviewsRepo.preload([
      buildReview({ cakeId, userId: 'u-a', rating: 5, helpfulCount: 1 }),
      buildReview({ cakeId, userId: 'u-b', rating: 5, helpfulCount: 10 }),
      buildReview({ cakeId, userId: 'u-c', rating: 5, helpfulCount: 5 }),
    ]);

    const res = await app.request(`/v1/cakes/${cakeId}/reviews?sort=helpful`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ user_id: string; helpful_count: number }>;
    };
    expect(body.reviews.map((r) => r.user_id)).toEqual(['u-b', 'u-c', 'u-a']);
    expect(body.reviews.map((r) => r.helpful_count)).toEqual([10, 5, 1]);
  });

  it('filter_rating で星評価による絞り込みができる（stats は全件ベース）', async () => {
    const { app, reviewsRepo } = buildTestApp();
    const cakeId = randomUUID();
    reviewsRepo.preload([
      buildReview({ cakeId, userId: 'u1', rating: 5 }),
      buildReview({ cakeId, userId: 'u2', rating: 5 }),
      buildReview({ cakeId, userId: 'u3', rating: 3 }),
    ]);

    const res = await app.request(`/v1/cakes/${cakeId}/reviews?filter_rating=5`);
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

  it('verified_only=true で購入済みバッジ付きだけに絞れる', async () => {
    const { app, reviewsRepo } = buildTestApp();
    const cakeId = randomUUID();
    reviewsRepo.preload([
      buildReview({ cakeId, userId: 'u-verified', rating: 5, isVerifiedPurchaser: true }),
      buildReview({ cakeId, userId: 'u-unverified', rating: 4, isVerifiedPurchaser: false }),
    ]);

    const res = await app.request(`/v1/cakes/${cakeId}/reviews?verified_only=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ user_id: string; is_verified_purchaser: boolean }>;
    };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]?.user_id).toBe('u-verified');
  });

  it('limit が境界外なら 400 VALIDATION_ERROR を返す', async () => {
    const { app } = buildTestApp();
    const cakeId = randomUUID();

    const tooLarge = await app.request(`/v1/cakes/${cakeId}/reviews?limit=101`);
    expect(tooLarge.status).toBe(400);
    const tooSmall = await app.request(`/v1/cakes/${cakeId}/reviews?limit=0`);
    expect(tooSmall.status).toBe(400);
  });

  describe('カーソルページネーション', () => {
    it('limit を超える件数があるとき next_cursor + Link ヘッダを返し、次ページで残りを取得できる', async () => {
      const { app, reviewsRepo } = buildTestApp();
      const cakeId = randomUUID();
      // 3 件 / limit=2 で「ページ1: 2件 + next_cursor」「ページ2: 1件」になる
      reviewsRepo.preload([
        buildReview({
          cakeId,
          userId: 'u-old',
          rating: 5,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        buildReview({
          cakeId,
          userId: 'u-mid',
          rating: 4,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        }),
        buildReview({
          cakeId,
          userId: 'u-new',
          rating: 3,
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ]);

      const res1 = await app.request(`/v1/cakes/${cakeId}/reviews?limit=2`);
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        reviews: Array<{ user_id: string }>;
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(body1.reviews.map((r) => r.user_id)).toEqual(['u-new', 'u-mid']);
      expect(body1.has_more).toBe(true);
      expect(body1.next_cursor).not.toBeNull();
      // RFC 5988 Link ヘッダで次ページ URL を提示する
      const link = res1.headers.get('Link');
      expect(link).toContain('rel="next"');
      expect(link).toContain('after=');

      // next_cursor を after に渡して次ページ取得
      const res2 = await app.request(
        `/v1/cakes/${cakeId}/reviews?limit=2&after=${encodeURIComponent(body1.next_cursor as string)}`,
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
      const { app, reviewsRepo } = buildTestApp();
      const cakeId = randomUUID();
      reviewsRepo.preload([
        buildReview({
          cakeId,
          userId: 'u1',
          rating: 5,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        buildReview({
          cakeId,
          userId: 'u2',
          rating: 4,
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ]);

      // sort=newest で 1 ページ目を取得 → next_cursor が出る
      const res1 = await app.request(`/v1/cakes/${cakeId}/reviews?sort=newest&limit=1`);
      const body1 = (await res1.json()) as { next_cursor: string | null };
      expect(body1.next_cursor).not.toBeNull();

      // 同じカーソルを sort=helpful で渡す → 400
      const res2 = await app.request(
        `/v1/cakes/${cakeId}/reviews?sort=helpful&limit=1&after=${encodeURIComponent(
          body1.next_cursor as string,
        )}`,
      );
      expect(res2.status).toBe(400);
      const body2 = (await res2.json()) as { error: { code: string } };
      expect(body2.error.code).toBe('VALIDATION_ERROR');
    });

    it('改竄カーソルは 400 VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp();
      const cakeId = randomUUID();
      const res = await app.request(`/v1/cakes/${cakeId}/reviews?after=not-a-valid-cursor`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('POST /v1/cakes/:cake_id/reviews（要認証）', () => {
  it('201 と作成されたレビューを返す（購入実績が無ければ is_verified_purchaser=false）', async () => {
    const { app, reviewsRepo } = buildTestApp({ user: AUTH_USER });
    const cakeId = randomUUID();

    const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rating: 5,
        title: 'とても美味しかった',
        body: '生クリームの甘さが絶妙でした。',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      cake_id: string;
      user_id: string;
      rating: number;
      title: string;
      body: string;
      is_verified_purchaser: boolean;
      helpful_count: number;
      created_at: string;
    };
    expect(body.id).toMatch(UUID_REGEX);
    expect(body.cake_id).toBe(cakeId);
    expect(body.user_id).toBe(AUTH_USER.id);
    expect(body.rating).toBe(5);
    expect(body.title).toBe('とても美味しかった');
    expect(body.is_verified_purchaser).toBe(false);
    expect(body.helpful_count).toBe(0);
    // 永続化されている
    const stats = await reviewsRepo.statsByCake(CakeId.from(cakeId));
    expect(stats.count).toBe(1);
  });

  it('購入済みなら is_verified_purchaser=true で snapshot される', async () => {
    const { app, verifiedChecker } = buildTestApp({ user: AUTH_USER });
    const cakeId = randomUUID();
    verifiedChecker.markPurchased(AUTH_USER.id, cakeId);

    const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 4, title: 'good', body: 'ok' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { is_verified_purchaser: boolean };
    expect(body.is_verified_purchaser).toBe(true);
  });

  describe('認証ガード', () => {
    it('未認証だと 401 + UNAUTHORIZED を返し、レビューは作成されない', async () => {
      const { app, reviewsRepo } = buildTestApp({ user: null });
      const cakeId = randomUUID();

      const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 5, title: 't', body: 'b' }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      const stats = await reviewsRepo.statsByCake(CakeId.from(cakeId));
      expect(stats.count).toBe(0);
    });
  });

  describe('業務エラー', () => {
    it('同じユーザーが同じケーキに 2 回投稿すると 409 CONFLICT を返す', async () => {
      const { app, reviewsRepo } = buildTestApp({ user: AUTH_USER });
      const cakeId = randomUUID();
      reviewsRepo.preload([buildReview({ cakeId, userId: AUTH_USER.id, rating: 5 })]);

      const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 4, title: 't', body: 'b' }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toContain(cakeId);
    });

    it('別ユーザーは同じケーキに投稿できる', async () => {
      const { app, reviewsRepo } = buildTestApp({ user: OTHER_USER });
      const cakeId = randomUUID();
      reviewsRepo.preload([buildReview({ cakeId, userId: AUTH_USER.id, rating: 5 })]);

      const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
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
      const cakeId = randomUUID();

      const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
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
      const cakeId = randomUUID();

      const res = await app.request(`/v1/cakes/${cakeId}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 5, title: '', body: 'b' }),
      });

      expect(res.status).toBe(400);
    });

    it('cake_id が UUID でなければ 400 VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp({ user: AUTH_USER });
      const res = await app.request('/v1/cakes/not-a-uuid/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 5, title: 't', body: 'b' }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('reviews router と cakeRouter の共存', () => {
  it('/v1/cakes/:id は cakeRouter（GET /:id）が拾い、/v1/cakes/:cake_id/reviews は reviewsRouter が拾う', async () => {
    // reviews ルーターを同じ /v1/cakes プレフィックスにマウントしても、
    // Hono の trie が '/:id' と '/:cake_id/reviews' を別パスとして扱うことを確認する。
    const { app, reviewsRepo } = buildTestApp();
    const cakeId = randomUUID();
    reviewsRepo.preload([buildReview({ cakeId, userId: 'u1', rating: 5 })]);

    // reviews 側は 200 を返す
    const reviewsRes = await app.request(`/v1/cakes/${cakeId}/reviews`);
    expect(reviewsRes.status).toBe(200);
    const body = (await reviewsRes.json()) as { reviews: unknown[] };
    expect(body.reviews).toHaveLength(1);

    // cake 詳細側は cake が存在しないため 404 を返す（reviews ルーターに食われていない）
    const cakeRes = await app.request(`/v1/cakes/${cakeId}`);
    expect(cakeRes.status).toBe(404);
  });
});
