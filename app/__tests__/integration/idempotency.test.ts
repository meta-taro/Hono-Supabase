import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp, type IdempotencyMiddlewares } from '@/app';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import {
  createIdempotencyMiddleware,
  ipOwner,
  userOwner,
} from '@/shared/http/idempotency.middleware';
import { InMemoryIdempotencyStore } from '@/shared/infrastructure/idempotency-store';
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
import { createFakeAuthMiddleware, requireAuth, requireAdmin } from '@/shared/http/auth.middleware';
import type { AppEnv, AuthUser, RequestModules } from '@/shared/http/request-context';

// ---------------------------------------------------------------------------
// Phase 10 Step 6: Idempotency-Key middleware の統合テスト。
//
//   目的:
//     - 「routes + middleware + store」の経路で、再送ケースの API 挙動が期待通りか確認する
//     - 各 POST エンドポイント（/v1/orders, /v1/cakes, /v1/customers）で同じ契約が成立するか
//     - owner（user / ip）+ scope による隔離
//     - rate-limit / auth との共存（idempotency が他のミドルウェアを壊さない）
//
//   なぜ store を InMemoryIdempotencyStore で代用するか:
//     Supabase 実 DB 経由の挙動は supabase-idempotency-store.test.ts で検証済み。
//     ここでは presentation 層の経路と middleware の組み合わせを高速・決定的に確認する。
// ---------------------------------------------------------------------------

const silentLogger = createSilentLogger();

const ADMIN_USER: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'admin@example.com',
  role: 'admin',
};

const AUTH_USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  role: 'authenticated',
};

interface TestApp {
  app: ReturnType<typeof createApp>;
  store: InMemoryIdempotencyStore;
  ordersRepo: InMemoryOrderRepository;
  seedCustomer: (authUserId: string) => Customer;
}

const buildIdempotency = (store: InMemoryIdempotencyStore): IdempotencyMiddlewares => ({
  orders: createIdempotencyMiddleware({
    store,
    scope: 'POST /v1/orders',
    resolveOwner: userOwner,
  }),
  cakes: createIdempotencyMiddleware({
    store,
    scope: 'POST /v1/cakes',
    resolveOwner: userOwner,
  }),
  customers: createIdempotencyMiddleware({
    store,
    scope: 'POST /v1/customers',
    resolveOwner: ipOwner,
  }),
});

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
    placeOrder: createPlaceOrderUseCase(ordersRepo, silentLogger),
    getOrder: createGetOrderUseCase(ordersRepo),
    listOrders: createListOrdersUseCase(ordersRepo),
    resolveCustomerId: async (authUserId) => {
      const c = await customersRepo.findByAuthUserId(authUserId);
      return c?.id.value ?? null;
    },
  });

  const modules: RequestModules = {
    cakes: cakesController,
    customers: customersController,
    orders: ordersController,
  };

  const stubSb = null as unknown as SupabaseClient;
  const fakeModulesMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set('sb', stubSb);
    c.set('modules', modules);
    await next();
  };

  const store = new InMemoryIdempotencyStore();
  const app = createApp({
    rootMiddlewares: [createFakeAuthMiddleware(params.user ?? null), fakeModulesMiddleware],
    guards: {
      adminGuard: [requireAuth(), requireAdmin()],
      authGuard: [requireAuth()],
    },
    idempotencyMiddlewares: buildIdempotency(store),
  });

  const seedCustomer = (authUserId: string): Customer => {
    const c = Customer.create({
      authUserId,
      name: 'テスト顧客',
      email: `customer-${authUserId.slice(0, 8)}@example.com`,
    });
    customersRepo.seed(c);
    return c;
  };

  return { app, store, ordersRepo, seedCustomer };
};

describe('Idempotency-Key middleware（POST /v1/* 統合）', () => {
  describe('POST /v1/orders（user スコープ）', () => {
    it('Idempotency-Key 欠落で 400 IDEMPOTENCY_KEY_REQUIRED を返す', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ cakeId, quantity: 1 }] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('同じ key + 同じ body の再送で 1 回目のレスポンスが replay される（在庫は 1 回分だけ減る）', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'order-key-1',
      };
      const body = JSON.stringify({ items: [{ cakeId, quantity: 2 }] });

      const first = await app.request('/v1/orders', { method: 'POST', headers, body });
      expect(first.status).toBe(201);
      expect(first.headers.get('Idempotency-Replayed')).toBeNull();
      const firstBody = (await first.json()) as { id: string };

      const second = await app.request('/v1/orders', { method: 'POST', headers, body });
      expect(second.status).toBe(201);
      expect(second.headers.get('Idempotency-Replayed')).toBe('true');
      const secondBody = (await second.json()) as { id: string };
      expect(secondBody.id).toBe(firstBody.id);

      // 在庫が 1 回分だけ減る（10 → 8。replay 経路では handler が走らない証拠）
      expect(ordersRepo.getStock(cakeId)).toBe(8);
    });

    it('同じ key で違う body だと 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'order-key-2',
      };
      await app.request('/v1/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: [{ cakeId, quantity: 2 }] }),
      });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: [{ cakeId, quantity: 3 }] }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('未認証 → 401 が先に出て idempotency 層には到達しない', async () => {
      const { app } = buildTestApp({ user: null });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, // Idempotency-Key 無し
        body: JSON.stringify({ items: [{ cakeId: randomUUID(), quantity: 1 }] }),
      });
      // auth が先に通っているので 401 になり、Idempotency-Key 欠落の 400 にはならない。
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/orders（Idempotency-Key 不要）', () => {
    it('GET 経路には Idempotency-Key middleware は走らない', async () => {
      const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);

      const res = await app.request('/v1/orders', { method: 'GET' });
      // 200 か空配列が返れば OK。少なくとも 400 IDEMPOTENCY_KEY_REQUIRED にはならない。
      expect(res.status).toBe(200);
    });
  });

  describe('POST /v1/cakes（admin + user スコープ）', () => {
    it('admin + 同じ key + 同じ body で replay される', async () => {
      const { app } = buildTestApp({ user: ADMIN_USER });
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'cake-key-1',
      };
      const body = JSON.stringify({ name: 'ショートケーキ', price: 600, stock: 10 });

      const first = await app.request('/v1/cakes', { method: 'POST', headers, body });
      expect(first.status).toBe(201);
      expect(first.headers.get('Idempotency-Replayed')).toBeNull();
      const firstBody = (await first.json()) as { id: string };

      const second = await app.request('/v1/cakes', { method: 'POST', headers, body });
      expect(second.status).toBe(201);
      expect(second.headers.get('Idempotency-Replayed')).toBe('true');
      const secondBody = (await second.json()) as { id: string };
      expect(secondBody.id).toBe(firstBody.id);
    });

    it('admin 権限なし → 403 が先に出て idempotency 層には到達しない', async () => {
      const { app } = buildTestApp({ user: AUTH_USER }); // role=authenticated

      const res = await app.request('/v1/cakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, // Idempotency-Key 無し
        body: JSON.stringify({ name: 'NG', price: 100, stock: 1 }),
      });
      expect(res.status).toBe(403);
    });

    it('GET /v1/cakes は Idempotency-Key 不要（middleware 非適用）', async () => {
      const { app } = buildTestApp({ user: null });
      const res = await app.request('/v1/cakes', { method: 'GET' });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /v1/customers（ip スコープ・未認証）', () => {
    it('Idempotency-Key 欠落で 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      const { app } = buildTestApp({ user: null });
      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice',
          email: 'alice@example.com',
          password: 'Strong@P4ss',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('同じ key + 同じ IP で再送すると replay される', async () => {
      const { app } = buildTestApp({ user: null });
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': 'signup-key-1',
        'cf-connecting-ip': '1.2.3.4',
      };
      const body = JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'Strong@P4ss',
      });

      const first = await app.request('/v1/customers', { method: 'POST', headers, body });
      expect(first.status).toBe(201);
      expect(first.headers.get('Idempotency-Replayed')).toBeNull();
      const firstBody = (await first.json()) as { id: string };

      const second = await app.request('/v1/customers', { method: 'POST', headers, body });
      expect(second.status).toBe(201);
      expect(second.headers.get('Idempotency-Replayed')).toBe('true');
      const secondBody = (await second.json()) as { id: string };
      expect(secondBody.id).toBe(firstBody.id);
    });

    it('IP が違えば同じ key を再利用しても 1 回目とは別エントリ扱い（隔離）', async () => {
      const { app } = buildTestApp({ user: null });
      const baseHeaders = {
        'content-type': 'application/json',
        'Idempotency-Key': 'signup-shared',
      };
      const bodyA = JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'Strong@P4ss',
      });
      const bodyB = JSON.stringify({
        name: 'Bob',
        email: 'bob@example.com',
        password: 'Strong@P4ss',
      });

      const a = await app.request('/v1/customers', {
        method: 'POST',
        headers: { ...baseHeaders, 'cf-connecting-ip': '1.1.1.1' },
        body: bodyA,
      });
      const b = await app.request('/v1/customers', {
        method: 'POST',
        headers: { ...baseHeaders, 'cf-connecting-ip': '2.2.2.2' },
        body: bodyB,
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers.get('Idempotency-Replayed')).toBeNull();
    });
  });

  describe('owner / scope の隔離（user と ip）', () => {
    it('orders（user 範囲）と customers（ip 範囲）で同じ key を再利用しても衝突しない', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

      const order = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'shared-key' },
        body: JSON.stringify({ items: [{ cakeId, quantity: 1 }] }),
      });
      expect(order.status).toBe(201);

      // customers は ip スコープ。auth user の操作とは scope が違うのでぶつからない。
      const signup = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'shared-key' },
        body: JSON.stringify({
          name: 'Alice',
          email: 'alice@example.com',
          password: 'Strong@P4ss',
        }),
      });
      expect(signup.status).toBe(201);
      expect(signup.headers.get('Idempotency-Replayed')).toBeNull();
    });
  });
});
