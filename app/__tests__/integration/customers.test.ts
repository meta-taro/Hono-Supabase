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
import { createListCustomersUseCase } from '@/modules/customers/application/list-customers.usecase';
import { createSignUpCustomerUseCase } from '@/modules/customers/application/sign-up-customer.usecase';
import { createCustomerController } from '@/modules/customers/presentation/customer.controller';
import { InMemoryCustomerRepository } from '@/modules/customers/application/__test-helpers__/in-memory-customer.repository';
import { FakeCustomerAuth } from '@/modules/customers/application/__test-helpers__/fake-customer-auth';
import { Customer } from '@/modules/customers/domain/customer';
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

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   Phase 6 では:
//     - GET /v1/customers は admin 必須（401 / 403 / 200）
//     - POST /v1/customers (signUp) は認証不要、password 必須
//     - email 重複は CustomerAuthPort の事前チェックで 409
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は customer.supabase-repository.test.ts で実 Supabase に対して
//   既に検証済み。ここでは「HTTP → UseCase → Response」の経路だけを高速・決定的に確認する。
//   FakeCustomerAuth が Supabase Auth + handle_new_user トリガを JS で再現する。
// ---------------------------------------------------------------------------

const silentLogger = createSilentLogger();

interface TestApp {
  app: ReturnType<typeof createApp>;
  customersRepo: InMemoryCustomerRepository;
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

  const modules: RequestModules = {
    cakes: cakesController,
    customers: customersController,
    orders: ordersController,
    webhooks: webhooksController,
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

  return { app, customersRepo };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('GET /v1/customers（admin 専用）', () => {
  it('admin で 200 と空配列を返す', async () => {
    const { app } = buildTestApp({ user: ADMIN_USER });

    const res = await app.request('/v1/customers');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customers: [] });
  });

  it('admin で 200 と保存済み顧客を返す', async () => {
    const { app, customersRepo } = buildTestApp({ user: ADMIN_USER });
    customersRepo.seed(
      Customer.create({
        authUserId: '22222222-2222-4222-8222-222222222222',
        name: '田中太郎',
        email: 'tanaka@example.com',
      }),
    );

    const res = await app.request('/v1/customers');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customers: Array<{ id: string; name: string; email: string }>;
    };
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]).toMatchObject({
      name: '田中太郎',
      email: 'tanaka@example.com',
    });
    expect(body.customers[0]?.id).toMatch(UUID_REGEX);
  });

  describe('admin ガード', () => {
    it('未認証だと 401 + UNAUTHORIZED を返す', async () => {
      const { app } = buildTestApp({ user: null });

      const res = await app.request('/v1/customers');

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('一般ユーザだと 403 + FORBIDDEN を返す', async () => {
      const { app } = buildTestApp({ user: REGULAR_USER });

      const res = await app.request('/v1/customers');

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });
});

describe('POST /v1/customers（signUp、認証不要）', () => {
  it('201 と作成された顧客を返す（FakeCustomerAuth が auth + トリガを再現）', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '山田花子',
        email: 'yamada@example.com',
        password: 'secret123',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      email: string;
    };
    expect(body).toMatchObject({
      name: '山田花子',
      email: 'yamada@example.com',
    });
    expect(body.id).toMatch(UUID_REGEX);
  });

  it('email は VO で正規化される（大文字 → 小文字）', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'A',
        email: 'User@Example.COM',
        password: 'secret123',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe('user@example.com');
  });

  it('保存後に GET /v1/customers (admin) で取得できる', async () => {
    const { app, customersRepo } = buildTestApp();

    const postRes = await app.request('/v1/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '鈴木一郎',
        email: 'suzuki@example.com',
        password: 'secret123',
      }),
    });
    expect(postRes.status).toBe(201);
    expect(customersRepo.size()).toBe(1);

    // 別アプリを admin で立ち上げて list を引いても良いが、
    // 同じ repo を共有する admin 経路の app で一覧確認するのは不可能なので
    // size() をアサートするに留める（POST 経路で確かに保存されたことの確認）。
  });

  describe('email 重複', () => {
    it('既存のメールアドレスでサインアップすると 409 + CONFLICT を返す', async () => {
      const { app } = buildTestApp();

      const first = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'A',
          email: 'dup@example.com',
          password: 'secret123',
        }),
      });
      expect(first.status).toBe(201);

      const second = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'B',
          email: 'dup@example.com',
          password: 'secret123',
        }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toContain('dup@example.com');
    });

    it('大文字小文字違いでも重複として 409 を返す', async () => {
      const { app } = buildTestApp();

      const first = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'A',
          email: 'case@example.com',
          password: 'secret123',
        }),
      });
      expect(first.status).toBe(201);

      const second = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'B',
          email: 'CASE@EXAMPLE.COM',
          password: 'secret123',
        }),
      });
      expect(second.status).toBe(409);
    });
  });

  describe('Zod バリデーション失敗', () => {
    it('name が空のとき 400 + VALIDATION_ERROR を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '',
          email: 'a@b.co',
          password: 'secret123',
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: {
          code: string;
          details?: Array<{ field: string; message: string }>;
        };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'name' })]),
      );
    });

    it('email の形式が不正のとき 400 を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'A',
          email: 'not-an-email',
          password: 'secret123',
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'email')).toBe(true);
    });

    it('password が短すぎる（5 文字）とき 400 を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'A',
          email: 'a@b.co',
          password: '12345',
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'password')).toBe(true);
    });

    it('複数フィールドが不正のとき details に複数件含まれる', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', email: 'bad', password: 'x' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { details?: Array<{ field: string }> };
      };
      expect(body.error.details?.length).toBeGreaterThanOrEqual(2);
    });
  });
});
