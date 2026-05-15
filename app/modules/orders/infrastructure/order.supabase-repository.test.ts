import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
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
import { loadEnv, type RawEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカル + place_order Postgres Function 経由」で動く。
// 起動済みの Supabase（`supabase start`）が必要。
//
// Phase 6 改定:
//   - customers の INSERT は handle_new_user トリガ経由のみ（auth.users 作成 → トリガで customers 行が埋まる）
//   - そのためテストでは sb.auth.admin.createUser() で顧客を seed する
//   - cleanup は「orders を先に削除 → auth.admin.deleteUser」の順で踏む
//     （customers→orders は本番上の理由から ON DELETE CASCADE にしておらず、auth.users 削除だけでは連鎖が止まる）
//
// テスト分離戦略:
//   - 顧客: メールアドレスに `@test-orders.local` ドメインを付けて目印化
//   - 商品:   name に `__test_orders_` プレフィックスを付けて目印化
//   - 注文 / 明細: 顧客削除前に明示削除（order_items は ON DELETE CASCADE で連動）
//   - 既存の cakes / customers のテストデータ（別プレフィックス／別ドメイン）には絶対に触れない

const TEST_PREFIX = '__test_orders_';
const TEST_EMAIL_DOMAIN = '@test-orders.local';

const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 削除順序の設計（重要）:
//   FK の ON DELETE 指定は次のとおりで、auth.users 削除だけでは連鎖が orders で止まる:
//     - auth.users → customers      : ON DELETE CASCADE（0004）
//     - customers  → orders         : 指定なし（= RESTRICT）— 本番で顧客削除＝注文履歴消失は望ましくないためあえて CASCADE にしない
//     - orders     → order_items    : ON DELETE CASCADE（0003）
//   そのため「顧客を消すなら注文を先に始末する」という本番でも踏むべき手順をテスト側でも踏む:
//     1. テスト対象の auth.users → customers.id を逆引き
//     2. 該当 customers の orders を先に DELETE（→ order_items も CASCADE で消える）
//     3. auth.admin.deleteUser で auth.users を削除（→ customers も CASCADE で消える）
//     4. テスト用 cakes 行を削除（cakes は auth 系列と独立）
const cleanupTestRows = async (): Promise<void> => {
  const { data, error } = await sbAdmin.auth.admin.listUsers({ perPage: 200 });
  if (error) {
    throw new Error(`auth.users 一覧取得に失敗: ${error.message}`);
  }

  const testAuthUserIds = data.users
    .filter((u) => u.email?.endsWith(TEST_EMAIL_DOMAIN))
    .map((u) => u.id);

  if (testAuthUserIds.length > 0) {
    // auth_user_id 経由で対応する customers.id を取得
    const { data: customerRows, error: cListErr } = await sbAdmin
      .from('customers')
      .select('id')
      .in('auth_user_id', testAuthUserIds);
    if (cListErr) {
      throw new Error(`テスト顧客の逆引きに失敗: ${cListErr.message}`);
    }
    const testCustomerIds = (customerRows ?? []).map((r) => r.id as string);

    // orders を先に削除（order_items は ON DELETE CASCADE で連動）
    if (testCustomerIds.length > 0) {
      const { error: oErr } = await sbAdmin
        .from('orders')
        .delete()
        .in('customer_id', testCustomerIds);
      if (oErr) {
        throw new Error(`テスト注文の削除に失敗: ${oErr.message}`);
      }
    }

    // auth.users を削除（customers は ON DELETE CASCADE で連動）
    for (const id of testAuthUserIds) {
      const del = await sbAdmin.auth.admin.deleteUser(id);
      if (del.error) {
        throw new Error(`auth.users 削除に失敗 (id=${id}): ${del.error.message}`);
      }
    }
  }

  const { error: cakesErr } = await sbAdmin.from('cakes').delete().like('name', `${TEST_PREFIX}%`);
  if (cakesErr) {
    throw new Error(`テスト商品の削除に失敗: ${cakesErr.message}`);
  }
};

interface SeedResult {
  customerId: string;
  cakeIds: string[];
}

// auth.admin.createUser で auth.users を作り、handle_new_user トリガで customers 行が
// 同一トランザクション内に作成される。トリガが入れた customers.id を読み戻して返す。
const seedFixtures = async (
  cakes: { name: string; price: number; stock: number }[],
): Promise<SeedResult> => {
  const email = `buyer-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}${TEST_EMAIL_DOMAIN}`;
  const { data: authData, error: authErr } = await sbAdmin.auth.admin.createUser({
    email,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { name: `${TEST_PREFIX}buyer` },
  });
  if (authErr || !authData.user) {
    throw new Error(`テスト顧客の投入に失敗: ${authErr?.message ?? '空応答'}`);
  }

  // トリガが作った customers.id を auth_user_id 経由で取得する
  const { data: customer, error: cErr } = await sbAdmin
    .from('customers')
    .select('id')
    .eq('auth_user_id', authData.user.id)
    .single();
  if (cErr || !customer) {
    throw new Error(`customers 行の取得に失敗（トリガ未動作？）: ${cErr?.message}`);
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
      const { customerId, cakeIds } = await seedFixtures([{ name: 'mont', price: 600, stock: 10 }]);

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
      const { customerId, cakeIds } = await seedFixtures([{ name: 'low', price: 500, stock: 2 }]);

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

      const { data: cakes } = await sbAdmin.from('cakes').select('id, stock').in('id', cakeIds);
      const stockMap = Object.fromEntries(
        (cakes ?? []).map((c) => [c.id as string, c.stock as number]),
      );
      expect(stockMap[cakeIds[0]!]).toBe(10); // 不変
      expect(stockMap[cakeIds[1]!]).toBe(1); // 不変
    });

    it('存在しない customer_id は CustomerNotFoundInOrderError', async () => {
      const { cakeIds } = await seedFixtures([{ name: 'a', price: 500, stock: 5 }]);

      await expect(
        repo.place({
          customerId: CustomerId.from('99999999-9999-4999-8999-999999999999'),
          items: [{ cakeId: CakeId.from(cakeIds[0]!), quantity: OrderQuantity.of(1) }],
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
      const { customerId, cakeIds } = await seedFixtures([{ name: 'find', price: 500, stock: 10 }]);

      const placed = await repo.place({
        customerId: CustomerId.from(customerId),
        items: [{ cakeId: CakeId.from(cakeIds[0]!), quantity: OrderQuantity.of(2) }],
      });

      const found = await repo.findById(placed.id);

      expect(found).not.toBeNull();
      expect(found?.id.equals(placed.id)).toBe(true);
      expect(found?.items).toHaveLength(1);
      expect(found?.totalAmount()).toBe(1000);
    });

    it('存在しない注文 ID では null を返す', async () => {
      const found = await repo.findById(OrderId.from('99999999-9999-4999-8999-999999999999'));
      expect(found).toBeNull();
    });
  });
});
