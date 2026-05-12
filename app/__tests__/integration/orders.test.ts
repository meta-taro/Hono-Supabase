import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '@/app';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
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
import { createOrderController } from '@/modules/orders/presentation/order.controller';
import { InMemoryOrderRepository } from '@/modules/orders/application/__test-helpers__/in-memory-order.repository';
import {
  createFakeAuthMiddleware,
  requireAuth,
  requireAdmin,
} from '@/shared/http/auth.middleware';
import type { AppEnv, AuthUser, RequestModules } from '@/shared/http/request-context';

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   Phase 6 で大きく変わった点:
//     - 全エンドポイントが認証必須（401 / FORBIDDEN）
//     - body から customerId を排除（identity spoofing 対策）
//     - controller の resolveCustomerId(authUserId) で業務 customer を解決
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は order.supabase-repository.test.ts で実 Supabase（place_order RPC 含む）
//   に対して既に検証済み。ここでは「HTTP → UseCase → Response」の経路だけを高速・決定的に確認する。
//   InMemoryOrderRepository は本番の place_order Postgres Function と同じ「all-or-nothing」
//   セマンティクスを JS で再現しているため、上から下まで通しで動かせる。
// ---------------------------------------------------------------------------

const silentLogger = createSilentLogger();

interface TestApp {
  app: ReturnType<typeof createApp>;
  ordersRepo: InMemoryOrderRepository;
  customersRepo: InMemoryCustomerRepository;
  // テスト用に「認証ユーザー → 業務 customer」の結びつけを準備するヘルパ。
  // 本番では handle_new_user トリガが行う処理を、テスト側でも 1 行で再現する。
  seedCustomer: (authUserId: string) => Customer;
}

// 共有のテストユーザー。authUserId として Customer に紐付ける。
const AUTH_USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  role: 'authenticated',
};

const buildTestApp = (params: { user?: AuthUser | null } = {}): TestApp => {
  const customersRepo = new InMemoryCustomerRepository();
  const customerAuth = new FakeCustomerAuth(customersRepo);
  const customersController = createCustomerController({
    listCustomers: createListCustomersUseCase(customersRepo),
    signUpCustomer: createSignUpCustomerUseCase(
      customerAuth,
      customersRepo,
      silentLogger,
    ),
  });

  const cakesRepo = new InMemoryCakeRepository();
  const cakesController = createCakeController({
    listCakes: createListCakesUseCase(cakesRepo),
    createCake: createCreateCakeUseCase(cakesRepo, silentLogger),
  });

  const ordersRepo = new InMemoryOrderRepository();
  const ordersController = createOrderController({
    placeOrder: createPlaceOrderUseCase(ordersRepo, silentLogger),
    getOrder: createGetOrderUseCase(ordersRepo),
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

  const app = createApp({
    rootMiddlewares: [
      createFakeAuthMiddleware(params.user ?? null),
      fakeModulesMiddleware,
    ],
    guards: {
      adminGuard: [requireAuth(), requireAdmin()],
      authGuard: [requireAuth()],
    },
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

  return { app, ordersRepo, customersRepo, seedCustomer };
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('POST /v1/orders（要認証）', () => {
  it('201 と作成された注文を返す（在庫が減算され、PLACED 状態）', async () => {
    const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
    const customer = seedCustomer(AUTH_USER.id);
    const cakeId = randomUUID();
    ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ cakeId, quantity: 2 }],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      customerId: string;
      status: string;
      totalAmount: number;
      placedAt: string;
      items: Array<{
        cakeId: string;
        quantity: number;
        unitPrice: number;
        subtotal: number;
      }>;
    };
    expect(body.id).toMatch(UUID_REGEX);
    // controller が JWT subject から resolveCustomerId 経由で取得した customer.id が入る
    expect(body.customerId).toBe(customer.id.value);
    expect(body.status).toBe('PLACED');
    expect(body.totalAmount).toBe(1200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      cakeId,
      quantity: 2,
      unitPrice: 600,
      subtotal: 1200,
    });
    // 在庫が減算されている
    expect(ordersRepo.getStock(cakeId)).toBe(8);
  });

  it('複数明細で totalAmount は subtotal の合計になる', async () => {
    const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
    seedCustomer(AUTH_USER.id);
    const cake1 = randomUUID();
    const cake2 = randomUUID();
    ordersRepo.seedCake({ cakeId: cake1, price: 600, stock: 5 });
    ordersRepo.seedCake({ cakeId: cake2, price: 800, stock: 5 });

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { cakeId: cake1, quantity: 2 },
          { cakeId: cake2, quantity: 1 },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { totalAmount: number };
    // 600 * 2 + 800 * 1 = 2000
    expect(body.totalAmount).toBe(2000);
  });

  describe('認証ガード', () => {
    it('未認証だと 401 + UNAUTHORIZED を返す', async () => {
      const { app } = buildTestApp({ user: null });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ cakeId: randomUUID(), quantity: 1 }],
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('認証ユーザーに対応する customer がいないと 404 + NOT_FOUND を返す', async () => {
      // user は認証済みだが seedCustomer を呼ばない（auth_user_id に紐づく customers 行がない）
      const { app } = buildTestApp({ user: AUTH_USER });
      const cakeId = randomUUID();

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ cakeId, quantity: 1 }],
        }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('NOT_FOUND');
      // CustomerNotFoundInOrderError は authUserId を含むメッセージ
      expect(body.error.message).toContain(AUTH_USER.id);
    });
  });

  describe('業務エラー', () => {
    it('在庫不足のとき 409 + CONFLICT を返す', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 1 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ cakeId, quantity: 5 }],
        }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toContain(cakeId);
      // 在庫は減らされていない（all-or-nothing）
      expect(ordersRepo.getStock(cakeId)).toBe(1);
    });

    it('存在しない cake を含むと 404 + NOT_FOUND を返す', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const existingCakeId = randomUUID();
      const missingCakeId = randomUUID();
      ordersRepo.seedCake({ cakeId: existingCakeId, price: 600, stock: 5 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            { cakeId: existingCakeId, quantity: 1 },
            { cakeId: missingCakeId, quantity: 1 },
          ],
        }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toContain(missingCakeId);
      // 既存 cake の在庫も変化しない（all-or-nothing）
      expect(ordersRepo.getStock(existingCakeId)).toBe(5);
    });

    it('同一 cakeId が複数行に分かれているとき 400 + VALIDATION_ERROR を返す', async () => {
      const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            { cakeId, quantity: 1 },
            { cakeId, quantity: 2 },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Zod バリデーション失敗', () => {
    it('items が空のとき 400 + VALIDATION_ERROR を返す', async () => {
      const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'items')).toBe(true);
    });

    it('cakeId が UUID でないとき 400 を返す', async () => {
      const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ cakeId: 'not-a-uuid', quantity: 1 }],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(
        body.error.details?.some((d) => d.field.includes('cakeId')),
      ).toBe(true);
    });

    it('quantity が 0 のとき 400 を返す', async () => {
      const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ cakeId: randomUUID(), quantity: 0 }],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('quantity が 100 を超えるとき 400 を返す', async () => {
      const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
      seedCustomer(AUTH_USER.id);

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ cakeId: randomUUID(), quantity: 101 }],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('GET /v1/orders/:id（要認証）', () => {
  it('保存された注文を取得できる（POST → GET ラウンドトリップ）', async () => {
    const { app, ordersRepo, seedCustomer } = buildTestApp({ user: AUTH_USER });
    seedCustomer(AUTH_USER.id);
    const cakeId = randomUUID();
    ordersRepo.seedCake({ cakeId, price: 700, stock: 5 });

    const postRes = await app.request('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ cakeId, quantity: 2 }],
      }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string };

    const getRes = await app.request(`/v1/orders/${created.id}`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      id: string;
      status: string;
      totalAmount: number;
      items: Array<{ cakeId: string; quantity: number }>;
    };
    expect(body.id).toBe(created.id);
    expect(body.status).toBe('PLACED');
    expect(body.totalAmount).toBe(1400);
    expect(body.items).toEqual([
      expect.objectContaining({ cakeId, quantity: 2 }),
    ]);
  });

  it('存在しない注文を取得すると 404 + NOT_FOUND を返す', async () => {
    const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
    seedCustomer(AUTH_USER.id);

    const res = await app.request(`/v1/orders/${randomUUID()}`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('id が UUID でないとき 400 + VALIDATION_ERROR を返す', async () => {
    const { app, seedCustomer } = buildTestApp({ user: AUTH_USER });
    seedCustomer(AUTH_USER.id);

    const res = await app.request('/v1/orders/not-a-uuid');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('未認証だと 401 + UNAUTHORIZED を返す', async () => {
    const { app } = buildTestApp({ user: null });

    const res = await app.request(`/v1/orders/${randomUUID()}`);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});

