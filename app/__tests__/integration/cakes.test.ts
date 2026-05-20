import { describe, it, expect } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '@/app';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
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
import { createFakeAuthMiddleware, requireAuth, requireAdmin } from '@/shared/http/auth.middleware';
import type { AppEnv, AuthUser, RequestModules } from '@/shared/http/request-context';

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

const buildTestApp = (params: { user?: AuthUser | null } = {}): TestApp => {
  const cakesRepo = new InMemoryCakeRepository();
  const cakesController = createCakeController({
    listCakes: createListCakesUseCase(cakesRepo),
    createCake: createCreateCakeUseCase(cakesRepo, silentLogger),
  });

  const customersRepo = new InMemoryCustomerRepository();
  const customerAuth = new FakeCustomerAuth(customersRepo);
  const customersController = createCustomerController({
    listCustomers: createListCustomersUseCase(customersRepo),
    signUpCustomer: createSignUpCustomerUseCase(customerAuth, customersRepo, silentLogger),
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
