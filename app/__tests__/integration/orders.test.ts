import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { createApp } from '@/app';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { InMemoryCakeRepository } from '@/modules/cakes/application/__test-helpers__/in-memory-cake.repository';
import { createListCustomersUseCase } from '@/modules/customers/application/list-customers.usecase';
import { createCreateCustomerUseCase } from '@/modules/customers/application/create-customer.usecase';
import { createCustomerController } from '@/modules/customers/presentation/customer.controller';
import { createCustomerRouter } from '@/modules/customers/presentation/customer.routes';
import { InMemoryCustomerRepository } from '@/modules/customers/application/__test-helpers__/in-memory-customer.repository';
import { createPlaceOrderUseCase } from '@/modules/orders/application/place-order.usecase';
import { createGetOrderUseCase } from '@/modules/orders/application/get-order.usecase';
import { createOrderController } from '@/modules/orders/presentation/order.controller';
import { createOrderRouter } from '@/modules/orders/presentation/order.routes';
import { InMemoryOrderRepository } from '@/modules/orders/application/__test-helpers__/in-memory-order.repository';

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   - Zod 検証 → 400 統一エラー形式
//   - 正常系のステータス / レスポンス形（PLACED / totalAmount / items）
//   - domain 例外（在庫不足 → 409、cake/customer 欠損 → 404、Order 欠損 → 404）
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は order.supabase-repository.test.ts で実 Supabase（place_order RPC 含む）
//   に対して既に検証済み。ここでは「HTTP → UseCase → Response」の経路だけを高速・決定的に確認する。
//   InMemoryOrderRepository は本番の place_order Postgres Function と同じ「all-or-nothing」
//   セマンティクスを JS で再現しているため、上から下まで通しで動かせる。
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });

interface TestApp {
  app: ReturnType<typeof createApp>;
  ordersRepo: InMemoryOrderRepository;
}

const buildTestApp = (): TestApp => {
  const ordersRepo = new InMemoryOrderRepository();
  const placeOrder = createPlaceOrderUseCase(ordersRepo, silentLogger);
  const getOrder = createGetOrderUseCase(ordersRepo);
  const ordersController = createOrderController({ placeOrder, getOrder });
  const ordersRouter = createOrderRouter(ordersController);

  // createApp() の AppModules インターフェースを満たすため、他コンテキストもダミーで組み立てる。
  // この orders 統合テストでは触らないが、app の構造を本番と一致させるために必要。
  const cakesRepo = new InMemoryCakeRepository();
  const cakesController = createCakeController({
    listCakes: createListCakesUseCase(cakesRepo),
    createCake: createCreateCakeUseCase(cakesRepo, silentLogger),
  });
  const cakesRouter = createCakeRouter(cakesController);

  const customersRepo = new InMemoryCustomerRepository();
  const customersController = createCustomerController({
    listCustomers: createListCustomersUseCase(customersRepo),
    createCustomer: createCreateCustomerUseCase(customersRepo, silentLogger),
  });
  const customersRouter = createCustomerRouter(customersController);

  const app = createApp({ cakesRouter, customersRouter, ordersRouter });
  return { app, ordersRepo };
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('POST /v1/orders', () => {
  it('201 と作成された注文を返す（在庫が減算され、PLACED 状態）', async () => {
    const { app, ordersRepo } = buildTestApp();
    const cakeId = randomUUID();
    const customerId = randomUUID();
    ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId,
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
    expect(body.customerId).toBe(customerId);
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
    const { app, ordersRepo } = buildTestApp();
    const cake1 = randomUUID();
    const cake2 = randomUUID();
    ordersRepo.seedCake({ cakeId: cake1, price: 600, stock: 5 });
    ordersRepo.seedCake({ cakeId: cake2, price: 800, stock: 5 });

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: randomUUID(),
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

  describe('業務エラー', () => {
    it('在庫不足のとき 409 + CONFLICT を返す', async () => {
      const { app, ordersRepo } = buildTestApp();
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 1 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: randomUUID(),
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
      const { app, ordersRepo } = buildTestApp();
      const existingCakeId = randomUUID();
      const missingCakeId = randomUUID();
      ordersRepo.seedCake({ cakeId: existingCakeId, price: 600, stock: 5 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: randomUUID(),
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
      const { app, ordersRepo } = buildTestApp();
      const cakeId = randomUUID();
      ordersRepo.seedCake({ cakeId, price: 600, stock: 10 });

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: randomUUID(),
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
      const { app } = buildTestApp();

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: randomUUID(),
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

    it('customerId が UUID でないとき 400 を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: 'not-a-uuid',
          items: [{ cakeId: randomUUID(), quantity: 1 }],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field.includes('customerId'))).toBe(true);
    });

    it('quantity が 0 のとき 400 を返す', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: randomUUID(),
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
      const { app } = buildTestApp();

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: randomUUID(),
          items: [{ cakeId: randomUUID(), quantity: 101 }],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('GET /v1/orders/:id', () => {
  it('保存された注文を取得できる（POST → GET ラウンドトリップ）', async () => {
    const { app, ordersRepo } = buildTestApp();
    const cakeId = randomUUID();
    ordersRepo.seedCake({ cakeId, price: 700, stock: 5 });

    const postRes = await app.request('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: randomUUID(),
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
    const { app } = buildTestApp();

    const res = await app.request(`/v1/orders/${randomUUID()}`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('id が UUID でないとき 400 + VALIDATION_ERROR を返す', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/orders/not-a-uuid');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
