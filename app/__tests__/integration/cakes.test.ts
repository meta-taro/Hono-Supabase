import { describe, it, expect } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { NoopEventPublisher } from '@/shared/application/event-publisher';
import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '@/app';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createGetCakeUseCase } from '@/modules/cakes/application/get-cake.usecase';
import { createUpdateCakeStockUseCase } from '@/modules/cakes/application/update-cake-stock.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { InMemoryCakeRepository } from '@/modules/cakes/application/__test-helpers__/in-memory-cake.repository';
import { Cake } from '@/modules/cakes/domain/cake';
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
import { createFakeAuthMiddleware, requireAuth, requireAdmin } from '@/shared/http/auth.middleware';
import type { AppEnv, AuthUser, RequestModules } from '@/shared/http/request-context';
import { InMemoryRateLimiter } from '@/shared/http/rate-limiter';
import {
  createRateLimitMiddleware,
  ipKey,
  noopRateLimitMiddleware,
  userOrIpKey,
} from '@/shared/http/rate-limit.middleware';
import type { RateLimitMiddlewares } from '@/app';

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   Phase 6 で auth ガードが入ったため、role 別の挙動も検証する。
//
//   - Zod 検証 → 400 統一エラー形式
//   - 正常系のステータス / レスポンス形
//   - admin ガード（401 / 403）
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は cake.supabase-repository.test.ts で実 Supabase に対して
//   既に検証済み。ここでは「HTTP → UseCase → Response」の経路だけを高速・決定的に確認する。
// ---------------------------------------------------------------------------

const silentLogger = createSilentLogger();

interface TestApp {
  app: ReturnType<typeof createApp>;
  cakesRepo: InMemoryCakeRepository;
}

const ADMIN_USER: AuthUser = {
  id: '99999999-9999-4999-8999-999999999999',
  email: 'admin@example.com',
  role: 'admin',
};

const REGULAR_USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  role: 'authenticated',
};

const buildTestApp = (
  params: { user?: AuthUser | null; rateLimits?: RateLimitMiddlewares } = {},
): TestApp => {
  const cakesRepo = new InMemoryCakeRepository();
  const cakesController = createCakeController({
    listCakes: createListCakesUseCase(cakesRepo),
    createCake: createCreateCakeUseCase(cakesRepo, silentLogger),
    getCake: createGetCakeUseCase(cakesRepo),
    updateCakeStock: createUpdateCakeStockUseCase(cakesRepo, silentLogger),
  });

  const customersRepo = new InMemoryCustomerRepository();
  const customerAuth = new FakeCustomerAuth(customersRepo);
  const customersController = createCustomerController({
    listCustomers: createListCustomersUseCase(customersRepo),
    signUpCustomer: createSignUpCustomerUseCase(customerAuth, customersRepo, silentLogger),
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

  const modules: RequestModules = {
    cakes: cakesController,
    customers: customersController,
    orders: ordersController,
    webhooks: webhooksController,
  };

  // テストでは sb を実体として持たないので null 相当のスタブを積む。
  // routes 層は c.get('modules') 経由で controller を引くため、sb を直接触らない。
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
    rateLimitMiddlewares: params.rateLimits,
  });

  return { app, cakesRepo };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ListCakesBody {
  cakes: Array<{ id: string; name: string; price: number; stock: number }>;
  next_cursor: string | null;
  has_more: boolean;
}

describe('GET /v1/cakes（認証不要）', () => {
  it('リポジトリが空のときは空ページを返す', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/cakes');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cakes: [], next_cursor: null, has_more: false });
  });

  it('保存済みケーキを Response DTO 形式 + ページネーションメタで返す', async () => {
    const { app, cakesRepo } = buildTestApp();
    await cakesRepo.save(Cake.create({ name: 'モンブラン', price: 600, stock: 10 }));

    const res = await app.request('/v1/cakes');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ListCakesBody;
    expect(body.cakes).toHaveLength(1);
    expect(body.cakes[0]).toMatchObject({
      name: 'モンブラン',
      price: 600,
      stock: 10,
    });
    expect(body.cakes[0]?.id).toMatch(UUID_REGEX);
    // 1 件 < 既定 limit(20) なので次ページなし
    expect(body.next_cursor).toBeNull();
    expect(body.has_more).toBe(false);
  });

  it('認証なしでもアクセスできる', async () => {
    const { app } = buildTestApp({ user: null });
    const res = await app.request('/v1/cakes');
    expect(res.status).toBe(200);
  });

  describe('カーソルページネーション', () => {
    const seedCakes = async (repo: InMemoryCakeRepository, count: number): Promise<void> => {
      for (let i = 0; i < count; i += 1) {
        await repo.save(
          Cake.create({ name: `cake-${String(i).padStart(2, '0')}`, price: 500, stock: 1 }),
        );
      }
    };

    it('limit で件数を絞り、has_more=true と next_cursor を返す', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedCakes(cakesRepo, 5);

      const res = await app.request('/v1/cakes?limit=2');

      expect(res.status).toBe(200);
      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.name)).toEqual(['cake-00', 'cake-01']);
      expect(body.has_more).toBe(true);
      expect(body.next_cursor).not.toBeNull();
      // Link ヘッダに次ページ URL（rel="next"）が付く
      expect(res.headers.get('Link')).toContain('rel="next"');
    });

    it('next_cursor を after に渡すと続きのページを返し、最終ページで has_more=false', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedCakes(cakesRepo, 3);

      const first = (await (await app.request('/v1/cakes?limit=2')).json()) as ListCakesBody;
      const after = encodeURIComponent(first.next_cursor ?? '');
      const res = await app.request(`/v1/cakes?limit=2&after=${after}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.name)).toEqual(['cake-02']);
      expect(body.has_more).toBe(false);
      expect(body.next_cursor).toBeNull();
      expect(res.headers.get('Link')).toBeNull();
    });

    it('limit が範囲外（0）のとき 400 + VALIDATION_ERROR', async () => {
      const { app } = buildTestApp();
      const res = await app.request('/v1/cakes?limit=0');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('limit が上限超過（101）のとき 400', async () => {
      const { app } = buildTestApp();
      const res = await app.request('/v1/cakes?limit=101');
      expect(res.status).toBe(400);
    });

    it('after カーソルが壊れているとき 400 + VALIDATION_ERROR', async () => {
      const { app } = buildTestApp();
      const res = await app.request('/v1/cakes?after=!!!not-a-valid-cursor!!!');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('ソート・フィルタ（Phase 10 Step 2）', () => {
    const seedVaried = async (repo: InMemoryCakeRepository): Promise<void> => {
      await repo.save(Cake.create({ name: 'いちごタルト', price: 500, stock: 0 }));
      await repo.save(Cake.create({ name: 'ガトーショコラ', price: 900, stock: 3 }));
      await repo.save(Cake.create({ name: 'いちごショート', price: 480, stock: 10 }));
    };

    it('sort=-price で価格降順に並ぶ', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedVaried(cakesRepo);

      const res = await app.request('/v1/cakes?sort=-price');

      expect(res.status).toBe(200);
      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.price)).toEqual([900, 500, 480]);
    });

    it('許可されていない sort フィールドは 400 + VALIDATION_ERROR', async () => {
      const { app } = buildTestApp();
      const res = await app.request('/v1/cakes?sort=created_at');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('available=true は在庫ありだけ返す', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedVaried(cakesRepo);

      const res = await app.request('/v1/cakes?available=true');

      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.name).sort()).toEqual(['いちごショート', 'ガトーショコラ']);
    });

    it('min_price / max_price で価格帯を絞る', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedVaried(cakesRepo);

      const res = await app.request('/v1/cakes?min_price=480&max_price=500');

      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.price).sort()).toEqual([480, 500]);
    });

    it('q でケーキ名を検索する（本番は PGroonga 全文検索 / テストは in-memory 近似）', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedVaried(cakesRepo);

      const res = await app.request(`/v1/cakes?q=${encodeURIComponent('いちご')}`);

      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.name).sort()).toEqual(['いちごショート', 'いちごタルト']);
    });

    it('min_price > max_price のとき 400 + VALIDATION_ERROR', async () => {
      const { app } = buildTestApp();
      const res = await app.request('/v1/cakes?min_price=900&max_price=100');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('sort を変えてカーソルを使い回すと 400（カーソルとソート不一致）', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedVaried(cakesRepo);

      // sort=-price で 1 ページ目を取り next_cursor を得る
      const first = (await (
        await app.request('/v1/cakes?limit=1&sort=-price')
      ).json()) as ListCakesBody;
      const after = encodeURIComponent(first.next_cursor ?? '');

      // 同じカーソルを sort=name で使い回す → keyset の整合が崩れるため 400
      const res = await app.request(`/v1/cakes?limit=1&sort=name&after=${after}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('sort=-price のカーソルを同じ sort で渡せば次ページが取れる', async () => {
      const { app, cakesRepo } = buildTestApp();
      await seedVaried(cakesRepo);

      const first = (await (
        await app.request('/v1/cakes?limit=1&sort=-price')
      ).json()) as ListCakesBody;
      expect(first.cakes.map((c) => c.price)).toEqual([900]);
      const after = encodeURIComponent(first.next_cursor ?? '');

      const res = await app.request(`/v1/cakes?limit=1&sort=-price&after=${after}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListCakesBody;
      expect(body.cakes.map((c) => c.price)).toEqual([500]);
    });
  });
});

describe('POST /v1/cakes（admin 専用）', () => {
  it('admin で 201 と作成されたケーキを返す', async () => {
    const { app } = buildTestApp({ user: ADMIN_USER });

    const res = await app.request('/v1/cakes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ガトーショコラ', price: 700, stock: 5 }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      price: number;
      stock: number;
    };
    expect(body).toMatchObject({
      name: 'ガトーショコラ',
      price: 700,
      stock: 5,
    });
    expect(body.id).toMatch(UUID_REGEX);
  });

  it('保存後に GET /v1/cakes で取得できる（ラウンドトリップ）', async () => {
    const { app } = buildTestApp({ user: ADMIN_USER });

    const postRes = await app.request('/v1/cakes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ティラミス', price: 650, stock: 8 }),
    });
    expect(postRes.status).toBe(201);

    const getRes = await app.request('/v1/cakes');
    const body = (await getRes.json()) as { cakes: Array<{ name: string }> };
    expect(body.cakes.map((c) => c.name)).toEqual(['ティラミス']);
  });

  describe('admin ガード', () => {
    it('未認証だと 401 + UNAUTHORIZED を返す', async () => {
      const { app } = buildTestApp({ user: null });

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', price: 500, stock: 5 }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('一般ユーザだと 403 + FORBIDDEN を返す', async () => {
      const { app } = buildTestApp({ user: REGULAR_USER });

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', price: 500, stock: 5 }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Zod バリデーション失敗', () => {
    it('name が空のとき 400 + VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp({ user: ADMIN_USER });

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', price: 500, stock: 5 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details?: Array<{ field: string; message: string }>;
        };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'name' })]),
      );
    });

    it('price が範囲外（0）のとき 400 を返す', async () => {
      const { app } = buildTestApp({ user: ADMIN_USER });

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', price: 0, stock: 5 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'price')).toBe(true);
    });

    it('stock が負のとき 400 を返す', async () => {
      const { app } = buildTestApp({ user: ADMIN_USER });

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', price: 500, stock: -1 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'stock')).toBe(true);
    });

    it('複数フィールドが不正のとき details に複数件含まれる', async () => {
      const { app } = buildTestApp({ user: ADMIN_USER });

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', price: -1, stock: -1 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { details?: Array<{ field: string }> };
      };
      expect(body.error.details?.length).toBeGreaterThanOrEqual(2);
    });
  });
});

interface CakeBody {
  id: string;
  name: string;
  price: number;
  stock: number;
}

// テスト用に 1 件だけ保存して id を返すヘルパ。
const seedOne = async (
  repo: InMemoryCakeRepository,
  props: { name: string; price: number; stock: number },
): Promise<string> => {
  const cake = Cake.create(props);
  await repo.save(cake);
  return cake.id.value;
};

describe('GET /v1/cakes/:id（認証不要・ETag 付き）', () => {
  it('存在する id で 200 + ケーキ + ETag(W/"1") を返す', async () => {
    const { app, cakesRepo } = buildTestApp();
    const id = await seedOne(cakesRepo, { name: 'ショートケーキ', price: 480, stock: 20 });

    const res = await app.request(`/v1/cakes/${id}`);

    expect(res.status).toBe(200);
    // 作成直後の version は 1 → Weak ETag は W/"1"
    expect(res.headers.get('ETag')).toBe('W/"1"');
    const body = (await res.json()) as CakeBody;
    expect(body).toMatchObject({ id, name: 'ショートケーキ', price: 480, stock: 20 });
  });

  it('認証なしでもアクセスできる（public）', async () => {
    const { app, cakesRepo } = buildTestApp({ user: null });
    const id = await seedOne(cakesRepo, { name: 'プリン', price: 300, stock: 5 });

    const res = await app.request(`/v1/cakes/${id}`);
    expect(res.status).toBe(200);
  });

  it('存在しない id で 404 + NOT_FOUND を返す', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/v1/cakes/22222222-2222-4222-8222-222222222222');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('id が UUID 形式でないとき 400 + VALIDATION_ERROR を返す', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/v1/cakes/not-a-uuid');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /v1/cakes/:id（admin 専用・楽観ロック）', () => {
  const patch = async (
    app: ReturnType<typeof createApp>,
    id: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    app.request(`/v1/cakes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('admin + 正しい If-Match で 200・在庫更新・新 ETag(W/"2") を返す', async () => {
    const { app, cakesRepo } = buildTestApp({ user: ADMIN_USER });
    const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

    const res = await patch(app, id, { stock: 50 }, { 'If-Match': 'W/"1"' });

    expect(res.status).toBe(200);
    // version が 1 → 2 に進み、ETag も更新される
    expect(res.headers.get('ETag')).toBe('W/"2"');
    const body = (await res.json()) as CakeBody;
    expect(body).toMatchObject({ id, stock: 50 });
  });

  it('If-Match が無いと 428 + PRECONDITION_REQUIRED を返す', async () => {
    const { app, cakesRepo } = buildTestApp({ user: ADMIN_USER });
    const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

    const res = await patch(app, id, { stock: 50 });

    expect(res.status).toBe(428);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('If-Match の版が古いと 412 + PRECONDITION_FAILED を返す（競合）', async () => {
    const { app, cakesRepo } = buildTestApp({ user: ADMIN_USER });
    const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

    // 1 回目の更新で version は 2 になる
    const first = await patch(app, id, { stock: 30 }, { 'If-Match': 'W/"1"' });
    expect(first.status).toBe(200);

    // 古い版 W/"1" を再提示 → 競合
    const second = await patch(app, id, { stock: 99 }, { 'If-Match': 'W/"1"' });
    expect(second.status).toBe(412);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PRECONDITION_FAILED');
  });

  it('If-Match の形式が不正だと 400 + VALIDATION_ERROR を返す', async () => {
    const { app, cakesRepo } = buildTestApp({ user: ADMIN_USER });
    const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

    const res = await patch(app, id, { stock: 50 }, { 'If-Match': 'garbage' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('存在しない id で 404 + NOT_FOUND を返す', async () => {
    const { app } = buildTestApp({ user: ADMIN_USER });

    const res = await patch(
      app,
      '22222222-2222-4222-8222-222222222222',
      { stock: 5 },
      { 'If-Match': 'W/"1"' },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('stock が負だと 400 + VALIDATION_ERROR を返す', async () => {
    const { app, cakesRepo } = buildTestApp({ user: ADMIN_USER });
    const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

    const res = await patch(app, id, { stock: -1 }, { 'If-Match': 'W/"1"' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  describe('admin ガード', () => {
    it('未認証だと 401 + UNAUTHORIZED を返す', async () => {
      const { app, cakesRepo } = buildTestApp({ user: null });
      const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

      const res = await patch(app, id, { stock: 50 }, { 'If-Match': 'W/"1"' });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('一般ユーザだと 403 + FORBIDDEN を返す', async () => {
      const { app, cakesRepo } = buildTestApp({ user: REGULAR_USER });
      const id = await seedOne(cakesRepo, { name: 'モンブラン', price: 600, stock: 10 });

      const res = await patch(app, id, { stock: 50 }, { 'If-Match': 'W/"1"' });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 10 Step 5: Rate Limit を routes 層に貼った配線が壊れていないかの統合テスト。
//
// 確認したいこと:
//   1. GET /v1/cakes に publicRead が効き、上限超過で 429 + Retry-After + 統一エラー本文
//   2. POST /v1/cakes には publicRead が「乗らない」ことを method 分離（restrictToMethods）
//      経由で担保（POST は別 limiter = authWrite に乗っている設計）
//
// 単体テスト（rate-limit.middleware.test.ts）は既に middleware + error-handler の
// 一気通貫を検証しているので、ここでは「app.ts → bootstrap 経路で routes に行き渡るか」
// の配線回帰だけを最小コストで担保する。
// ---------------------------------------------------------------------------
describe('Rate Limit（Phase 10 Step 5 配線確認）', () => {
  // 各テスト独立に limiter を建て直すヘルパ（窓共有を防ぐ）。
  const buildRateLimits = (params: {
    publicReadLimit: number;
    authWriteLimit: number;
  }): RateLimitMiddlewares => ({
    publicRead: createRateLimitMiddleware({
      limiter: new InMemoryRateLimiter({
        limit: params.publicReadLimit,
        periodSec: 10,
        now: () => 1000,
      }),
      retryAfterSec: 10,
      resolveKey: ipKey,
    }),
    publicWrite: noopRateLimitMiddleware,
    authWrite: createRateLimitMiddleware({
      limiter: new InMemoryRateLimiter({
        limit: params.authWriteLimit,
        periodSec: 10,
        now: () => 1000,
      }),
      retryAfterSec: 10,
      resolveKey: userOrIpKey,
    }),
  });

  it('GET /v1/cakes は publicRead の上限を超えると 429 + Retry-After を返す', async () => {
    const rateLimits = buildRateLimits({ publicReadLimit: 1, authWriteLimit: 100 });
    const { app } = buildTestApp({ rateLimits });

    const headers = { 'cf-connecting-ip': '203.0.113.1' };

    const ok = await app.request('/v1/cakes', { headers });
    expect(ok.status).toBe(200);

    const limited = await app.request('/v1/cakes', { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('10');
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('POST /v1/cakes は publicRead に乗らない（restrictToMethods による method 分離）', async () => {
    // publicReadLimit=1（1 リクエストで枯渇）でも、POST /v1/cakes は publicRead 側で
    // カウントされないことを確認する。authWrite は十分大きく取り、admin POST は通る。
    const rateLimits = buildRateLimits({ publicReadLimit: 1, authWriteLimit: 100 });
    const { app } = buildTestApp({ user: ADMIN_USER, rateLimits });

    const headers = {
      'cf-connecting-ip': '203.0.113.1',
      'Content-Type': 'application/json',
    };

    // publicRead を枯渇させる（同じ IP の GET を 1 回叩いて quota 使い切り）。
    const exhaust = await app.request('/v1/cakes', { headers });
    expect(exhaust.status).toBe(200);

    // POST は publicRead に乗らないので 429 にならず、201 で作成できる。
    const created = await app.request('/v1/cakes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'シフォン', price: 500, stock: 5 }),
    });
    expect(created.status).toBe(201);
  });
});
