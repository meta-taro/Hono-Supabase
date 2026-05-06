import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { OrderSupabaseRepository } from './order.supabase-repository';
import { CustomerId } from '../domain/customer-id.vo';
import { CakeId } from '../domain/cake-id.vo';
import { OrderQuantity } from '../domain/order-quantity.vo';
import { OrderId } from '../domain/order-id.vo';
import {
  InsufficientStockError,
  CakeNotFoundInOrderError,
  CustomerNotFoundInOrderError,
} from '../domain/order.errors';
import { loadEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカル + place_order Postgres Function 経由」で動く。
// 起動済みの Supabase（`supabase start`）が必要。
//
// テスト分離戦略:
//   - 顧客 / 商品: name に `__test_orders_` プレフィックスを付け、テストデータを目印化
//   - 注文 / 明細: name 列が無いため、テスト顧客の customer_id 経由で限定削除
//   - 既存の cakes / customers のテストデータ（別プレフィックス）には絶対に触れない

const TEST_PREFIX = '__test_orders_';

const env = loadEnv();
const sbAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const cleanupTestRows = async (): Promise<void> => {
  // テスト顧客の id を集める
  const { data: testCustomers } = await sbAdmin
    .from('customers')
    .select('id')
    .like('name', `${TEST_PREFIX}%`);

  const customerIds = (testCustomers ?? []).map((c) => c.id as string);

  // 注文を削除（order_items は ON DELETE CASCADE で連動削除される）
  if (customerIds.length > 0) {
    const { error: ordersErr } = await sbAdmin
      .from('orders')
      .delete()
      .in('customer_id', customerIds);
    if (ordersErr) {
      throw new Error(`テスト注文の削除に失敗: ${ordersErr.message}`);
    }
    const { error: customersErr } = await sbAdmin
      .from('customers')
      .delete()
      .in('id', customerIds);
    if (customersErr) {
      throw new Error(`テスト顧客の削除に失敗: ${customersErr.message}`);
    }
  }

  // テスト商品の削除
  const { error: cakesErr } = await sbAdmin
    .from('cakes')
    .delete()
    .like('name', `${TEST_PREFIX}%`);
  if (cakesErr) {
    throw new Error(`テスト商品の削除に失敗: ${cakesErr.message}`);
  }
};

// テストごとに「顧客 1 名 + 商品 N 件」を投入してから検証に入る。
interface SeedResult {
  customerId: string;
  cakeIds: string[];
}
const seedFixtures = async (
  cakes: { name: string; price: number; stock: number }[],
): Promise<SeedResult> => {
  const { data: customer, error: cErr } = await sbAdmin
    .from('customers')
    .insert({
      name: `${TEST_PREFIX}buyer`,
      email: `${TEST_PREFIX}${Date.now()}@example.com`,
    })
    .select('id')
    .single();
  if (cErr || !customer) {
    throw new Error(`テスト顧客の投入に失敗: ${cErr?.message}`);
  }

  const { data: cakeRows, error: kErr } = await sbAdmin
    .from('cakes')
    .insert(cakes.map((c) => ({ ...c, name: `${TEST_PREFIX}${c.name}` })))
    .select('id');
  if (kErr || !cakeRows) {
    throw new Error(`テスト商品の投入に失敗: ${kErr?.message}`);
  }

  return {
    customerId: customer.id as string,
    cakeIds: cakeRows.map((r) => r.id as string),
  };
};

describe('OrderSupabaseRepository（実 Supabase ローカル + place_order Function）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const repo = new OrderSupabaseRepository(sbAdmin);

  describe('place()', () => {
    it('在庫減算 + 注文作成 + 明細作成をアトミック実行する', async () => {
      const { customerId, cakeIds } = await seedFixtures([
        { name: 'mont', price: 600, stock: 10 },
      ]);

      const order = await repo.place({
        customerId: CustomerId.from(customerId),
        items: [
          {
            cakeId: CakeId.from(cakeIds[0]!),
            quantity: OrderQuantity.of(3),
          },
        ],
      });

      // 戻り値の Order が正しく構築されているか
      expect(order.customerId.value).toBe(customerId);
      expect(order.items).toHaveLength(1);
      expect(order.items[0]?.unitPrice).toBe(600); // スナップショット
      expect(order.totalAmount()).toBe(1800);

      // 在庫が減っているか
      const { data: cake } = await sbAdmin
        .from('cakes')
        .select('stock')
        .eq('id', cakeIds[0]!)
        .single();
      expect(cake?.stock).toBe(7);

      // orders / order_items に書き込まれているか
      const { data: dbOrder } = await sbAdmin
        .from('orders')
        .select('total_amount, status')
        .eq('id', order.id.value)
        .single();
      expect(dbOrder).toEqual({ total_amount: 1800, status: 'PLACED' });

      const { data: items } = await sbAdmin
        .from('order_items')
        .select('cake_id, quantity, unit_price, subtotal')
        .eq('order_id', order.id.value);
      expect(items).toEqual([
        {
          cake_id: cakeIds[0],
          quantity: 3,
          unit_price: 600,
          subtotal: 1800,
        },
      ]);
    });

    it('複数明細でも合計が正しく計算される', async () => {
      const { customerId, cakeIds } = await seedFixtures([
        { name: 'a', price: 500, stock: 5 },
        { name: 'b', price: 750, stock: 3 },
      ]);

      const order = await repo.place({
        customerId: CustomerId.from(customerId),
        items: [
          { cakeId: CakeId.from(cakeIds[0]!), quantity: OrderQuantity.of(2) }, // 1000
          { cakeId: CakeId.from(cakeIds[1]!), quantity: OrderQuantity.of(1) }, // 750
        ],
      });

      expect(order.totalAmount()).toBe(1750);
      expect(order.items).toHaveLength(2);
    });

    it('在庫不足は InsufficientStockError + 在庫が変わっていない（all-or-nothing）', async () => {
      const { customerId, cakeIds } = await seedFixtures([
        { name: 'low', price: 500, stock: 2 },
      ]);

      await expect(
        repo.place({
          customerId: CustomerId.from(customerId),
          items: [
            {
              cakeId: CakeId.from(cakeIds[0]!),
              quantity: OrderQuantity.of(5),
            },
          ],
        }),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      const { data: cake } = await sbAdmin
        .from('cakes')
        .select('stock')
        .eq('id', cakeIds[0]!)
        .single();
      expect(cake?.stock).toBe(2); // ロールバックで在庫不変
    });

    it('複数明細のうち 1 件が在庫不足のとき、他の在庫も減らない（all-or-nothing）', async () => {
      const { customerId, cakeIds } = await seedFixtures([
        { name: 'a', price: 500, stock: 10 },
        { name: 'b', price: 750, stock: 1 },
      ]);

      await expect(
        repo.place({
          customerId: CustomerId.from(customerId),
          items: [
            { cakeId: CakeId.from(cakeIds[0]!), quantity: OrderQuantity.of(2) },
            { cakeId: CakeId.from(cakeIds[1]!), quantity: OrderQuantity.of(5) },
          ],
        }),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      const { data: cakes } = await sbAdmin
        .from('cakes')
        .select('id, stock')
        .in('id', cakeIds);
      const stockMap = Object.fromEntries(
        (cakes ?? []).map((c) => [c.id as string, c.stock as number]),
      );
      expect(stockMap[cakeIds[0]!]).toBe(10); // 不変
      expect(stockMap[cakeIds[1]!]).toBe(1); // 不変
    });

    it('存在しない customer_id は CustomerNotFoundInOrderError', async () => {
      const { cakeIds } = await seedFixtures([
        { name: 'a', price: 500, stock: 5 },
      ]);

      await expect(
        repo.place({
          customerId: CustomerId.from('99999999-9999-4999-8999-999999999999'),
          items: [
            { cakeId: CakeId.from(cakeIds[0]!), quantity: OrderQuantity.of(1) },
          ],
        }),
      ).rejects.toBeInstanceOf(CustomerNotFoundInOrderError);
    });

    it('存在しない cake_id は CakeNotFoundInOrderError', async () => {
      const { customerId } = await seedFixtures([]);

      await expect(
        repo.place({
          customerId: CustomerId.from(customerId),
          items: [
            {
              cakeId: CakeId.from('99999999-9999-4999-8999-999999999999'),
              quantity: OrderQuantity.of(1),
            },
          ],
        }),
      ).rejects.toBeInstanceOf(CakeNotFoundInOrderError);
    });
  });

  describe('findById()', () => {
    it('保存済み注文を取得できる（明細含む）', async () => {
      const { customerId, cakeIds } = await seedFixtures([
        { name: 'find', price: 500, stock: 10 },
      ]);

      const placed = await repo.place({
        customerId: CustomerId.from(customerId),
        items: [
          { cakeId: CakeId.from(cakeIds[0]!), quantity: OrderQuantity.of(2) },
        ],
      });

      const found = await repo.findById(placed.id);

      expect(found).not.toBeNull();
      expect(found?.id.equals(placed.id)).toBe(true);
      expect(found?.items).toHaveLength(1);
      expect(found?.totalAmount()).toBe(1000);
    });

    it('存在しない注文 ID では null を返す', async () => {
      const found = await repo.findById(
        OrderId.from('99999999-9999-4999-8999-999999999999'),
      );
      expect(found).toBeNull();
    });
  });
});
