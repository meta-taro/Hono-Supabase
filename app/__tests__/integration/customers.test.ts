import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { createApp } from '@/app';
import { createListCustomersUseCase } from '@/modules/customers/application/list-customers.usecase';
import { createCreateCustomerUseCase } from '@/modules/customers/application/create-customer.usecase';
import { createCustomerController } from '@/modules/customers/presentation/customer.controller';
import { createCustomerRouter } from '@/modules/customers/presentation/customer.routes';
import { InMemoryCustomerRepository } from '@/modules/customers/application/__test-helpers__/in-memory-customer.repository';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { InMemoryCakeRepository } from '@/modules/cakes/application/__test-helpers__/in-memory-cake.repository';
import { Customer } from '@/modules/customers/domain/customer';
import { createPlaceOrderUseCase } from '@/modules/orders/application/place-order.usecase';
import { createGetOrderUseCase } from '@/modules/orders/application/get-order.usecase';
import { createOrderController } from '@/modules/orders/presentation/order.controller';
import { createOrderRouter } from '@/modules/orders/presentation/order.routes';
import { InMemoryOrderRepository } from '@/modules/orders/application/__test-helpers__/in-memory-order.repository';

// ---------------------------------------------------------------------------
// この統合テストの目的:
//   presentation 層（routes / controller / dto）の HTTP 動作を確認する。
//   - Zod 検証 → 400 統一エラー形式
//   - 正常系のステータス / レスポンス形
//   - メール重複時の 409 + EmailAlreadyTakenError 経路
//
// なぜ Supabase に繋がないのか:
//   infrastructure 層は customer.supabase-repository.test.ts で実 Supabase に対して
//   既に検証済み。ここでは「HTTP → UseCase → Response」の経路だけを高速・決定的に確認する。
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });

interface TestApp {
  app: ReturnType<typeof createApp>;
  repo: InMemoryCustomerRepository;
}

const buildTestApp = (): TestApp => {
  const repo = new InMemoryCustomerRepository();
  const listCustomers = createListCustomersUseCase(repo);
  const createCustomer = createCreateCustomerUseCase(repo, silentLogger);
  const customerController = createCustomerController({ listCustomers, createCustomer });
  const customersRouter = createCustomerRouter(customerController);

  // createApp() の AppModules インターフェースを満たすため、他コンテキストもダミーで組み立てる。
  // これは customers 統合テストでは触らないが、app の構造を本番と一致させるために必要。
  const cakesRepo = new InMemoryCakeRepository();
  const cakesController = createCakeController({
    listCakes: createListCakesUseCase(cakesRepo),
    createCake: createCreateCakeUseCase(cakesRepo, silentLogger),
  });
  const cakesRouter = createCakeRouter(cakesController);

  const ordersRepo = new InMemoryOrderRepository();
  const ordersController = createOrderController({
    placeOrder: createPlaceOrderUseCase(ordersRepo, silentLogger),
    getOrder: createGetOrderUseCase(ordersRepo),
  });
  const ordersRouter = createOrderRouter(ordersController);

  const app = createApp({ cakesRouter, customersRouter, ordersRouter });
  return { app, repo };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('GET /v1/customers', () => {
  it('リポジトリが空のときは空配列を返す', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/customers');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customers: [] });
  });

  it('保存済み顧客を Response DTO 形式で返す', async () => {
    const { app, repo } = buildTestApp();
    await repo.save(Customer.create({ name: '田中太郎', email: 'tanaka@example.com' }));

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
});

describe('POST /v1/customers', () => {
  it('201 と作成された顧客を返す（Customer.create で UUID 自動採番）', async () => {
    const { app } = buildTestApp();

    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '山田花子', email: 'yamada@example.com' }),
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
      body: JSON.stringify({ name: 'A', email: 'User@Example.COM' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe('user@example.com');
  });

  it('保存後に GET /v1/customers で取得できる（ラウンドトリップ）', async () => {
    const { app } = buildTestApp();

    const postRes = await app.request('/v1/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '鈴木一郎', email: 'suzuki@example.com' }),
    });
    expect(postRes.status).toBe(201);

    const getRes = await app.request('/v1/customers');
    const body = (await getRes.json()) as { customers: Array<{ name: string }> };
    expect(body.customers.map((c) => c.name)).toEqual(['鈴木一郎']);
  });

  describe('メール重複', () => {
    it('既存のメールアドレスでサインアップすると 409 + CONFLICT を返す', async () => {
      const { app } = buildTestApp();

      // 1 件目は成功
      const first = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A', email: 'dup@example.com' }),
      });
      expect(first.status).toBe(201);

      // 2 件目は 409
      const second = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'B', email: 'dup@example.com' }),
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
        body: JSON.stringify({ name: 'A', email: 'case@example.com' }),
      });
      expect(first.status).toBe(201);

      const second = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'B', email: 'CASE@EXAMPLE.COM' }),
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
        body: JSON.stringify({ name: '', email: 'a@b.co' }),
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
        body: JSON.stringify({ name: 'A', email: 'not-an-email' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.some((d) => d.field === 'email')).toBe(true);
    });

    it('複数フィールドが不正のとき details に複数件含まれる', async () => {
      const { app } = buildTestApp();

      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', email: 'bad' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { details?: Array<{ field: string }> };
      };
      expect(body.error.details?.length).toBeGreaterThanOrEqual(2);
    });
  });
});
