import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import { SupabaseVerifiedPurchaserChecker } from './supabase-verified-purchaser.checker';
import { loadEnv, type RawEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカル + has_purchased RPC」に対して動く。
// `supabase start` が前提。
//
// 検証対象:
//   - has_purchased(p_auth_user_id, p_cake_id) RPC が
//     PLACED の order_item を持つときに true、
//     CANCELED しか無い / 他ユーザーの注文 / 他ケーキの注文では false を返すこと。
//
// テスト分離戦略:
//   - auth ユーザー: @test-vpc.local を目印に
//   - cake:          name に `__test_vpc_` プレフィックス
//   - 注文 / 明細:   テスト顧客に紐づく分だけ cleanup で削除

const TEST_CAKE_PREFIX = '__test_vpc_';
const TEST_EMAIL_DOMAIN = '@test-vpc.local';

const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cleanupTestRows = async (): Promise<void> => {
  const { data, error } = await sbAdmin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`auth.users 一覧取得に失敗: ${error.message}`);
  const testAuthIds = data.users
    .filter((u) => u.email?.endsWith(TEST_EMAIL_DOMAIN))
    .map((u) => u.id);

  if (testAuthIds.length > 0) {
    const { data: customerRows } = await sbAdmin
      .from('customers')
      .select('id')
      .in('auth_user_id', testAuthIds);
    const customerIds = (customerRows ?? []).map((r) => r.id as string);
    if (customerIds.length > 0) {
      const { error: oErr } = await sbAdmin.from('orders').delete().in('customer_id', customerIds);
      if (oErr) throw new Error(`テスト注文削除失敗: ${oErr.message}`);
    }
    for (const id of testAuthIds) {
      const del = await sbAdmin.auth.admin.deleteUser(id);
      if (del.error) throw new Error(`auth.users 削除失敗 (id=${id}): ${del.error.message}`);
    }
  }

  const { error: cakesErr } = await sbAdmin
    .from('cakes')
    .delete()
    .like('name', `${TEST_CAKE_PREFIX}%`);
  if (cakesErr) throw new Error(`テスト商品削除失敗: ${cakesErr.message}`);
};

interface PurchaserSeed {
  authUserId: string;
  customerId: string;
}

const seedAuthUser = async (label: string): Promise<PurchaserSeed> => {
  const email = `vpc-${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}${TEST_EMAIL_DOMAIN}`;
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { name: `${TEST_CAKE_PREFIX}buyer` },
  });
  if (error || !data.user) throw new Error(`auth.user 作成失敗: ${error?.message ?? '空応答'}`);

  // handle_new_user トリガで投入された customers 行の id を逆引き
  const { data: customer, error: cErr } = await sbAdmin
    .from('customers')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .single();
  if (cErr || !customer) {
    throw new Error(`customers 行の取得に失敗（トリガ未動作？）: ${cErr?.message}`);
  }
  return { authUserId: data.user.id, customerId: customer.id as string };
};

const seedCake = async (suffix: string): Promise<string> => {
  const { data, error } = await sbAdmin
    .from('cakes')
    .insert({ name: `${TEST_CAKE_PREFIX}${suffix}`, price: 500, stock: 10 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`cakes 投入失敗: ${error?.message}`);
  return data.id as string;
};

// 注文 + 1 明細を投入する。place_order RPC は使わず直挿入（在庫減算は本テストの関心事ではない）。
const insertOrderWithItem = async (params: {
  customerId: string;
  cakeId: string;
  status: 'PLACED' | 'CANCELED';
}): Promise<void> => {
  const orderId = randomUUID();
  const { error: oErr } = await sbAdmin.from('orders').insert({
    id: orderId,
    customer_id: params.customerId,
    status: params.status,
    total_amount: 500,
  });
  if (oErr) throw new Error(`orders 投入失敗: ${oErr.message}`);

  const { error: iErr } = await sbAdmin.from('order_items').insert({
    id: randomUUID(),
    order_id: orderId,
    cake_id: params.cakeId,
    quantity: 1,
    unit_price: 500,
    subtotal: 500,
  });
  if (iErr) throw new Error(`order_items 投入失敗: ${iErr.message}`);
};

describe('SupabaseVerifiedPurchaserChecker（実 Supabase ローカル + has_purchased RPC）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const checker = new SupabaseVerifiedPurchaserChecker(sbAdmin);

  it('PLACED の order_item があれば true', async () => {
    const { authUserId, customerId } = await seedAuthUser('has');
    const cakeId = await seedCake('has');
    await insertOrderWithItem({ customerId, cakeId, status: 'PLACED' });

    expect(await checker.hasPurchased(authUserId, CakeId.from(cakeId))).toBe(true);
  });

  it('CANCELED 注文しかなければ false（未購入扱い）', async () => {
    const { authUserId, customerId } = await seedAuthUser('cancel');
    const cakeId = await seedCake('cancel');
    await insertOrderWithItem({ customerId, cakeId, status: 'CANCELED' });

    expect(await checker.hasPurchased(authUserId, CakeId.from(cakeId))).toBe(false);
  });

  it('別ユーザーの購入実績は他ユーザーに漏れない', async () => {
    const buyer = await seedAuthUser('buyer');
    const observer = await seedAuthUser('observer');
    const cakeId = await seedCake('iso');
    await insertOrderWithItem({
      customerId: buyer.customerId,
      cakeId,
      status: 'PLACED',
    });

    // observer は購入していない
    expect(await checker.hasPurchased(observer.authUserId, CakeId.from(cakeId))).toBe(false);
    // buyer 本人は true
    expect(await checker.hasPurchased(buyer.authUserId, CakeId.from(cakeId))).toBe(true);
  });

  it('別ケーキの購入実績は当該ケーキの判定に波及しない', async () => {
    const { authUserId, customerId } = await seedAuthUser('xcake');
    const cakeBought = await seedCake('bought');
    const cakeOther = await seedCake('other');
    await insertOrderWithItem({ customerId, cakeId: cakeBought, status: 'PLACED' });

    expect(await checker.hasPurchased(authUserId, CakeId.from(cakeOther))).toBe(false);
  });

  it('注文が 1 件もなければ false', async () => {
    const { authUserId } = await seedAuthUser('none');
    const cakeId = await seedCake('none');
    expect(await checker.hasPurchased(authUserId, CakeId.from(cakeId))).toBe(false);
  });
});
