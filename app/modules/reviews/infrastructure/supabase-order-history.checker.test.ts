import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { SupabaseOrderHistoryChecker } from './supabase-order-history.checker';
import { loadEnv, type RawEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカル + has_ordered RPC」に対して動く。
// `supabase start` が前提。
//
// 検証対象:
//   - has_ordered(p_auth_user_id) RPC が
//     PLACED の order を持つときに true、
//     CANCELED しか無い / 他ユーザーの注文 / 注文なしでは false を返すこと。
//   - cake を問わない（order_item の有無に依存しない）こと。
//
// テスト分離戦略:
//   - auth ユーザー: @test-ohc.local を目印に
//   - 注文:          テスト顧客に紐づく分だけ cleanup で削除

const TEST_NAME_PREFIX = '__test_ohc_';
const TEST_EMAIL_DOMAIN = '@test-ohc.local';

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
};

interface CustomerSeed {
  authUserId: string;
  customerId: string;
}

const seedAuthUser = async (label: string): Promise<CustomerSeed> => {
  const email = `ohc-${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}${TEST_EMAIL_DOMAIN}`;
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { name: `${TEST_NAME_PREFIX}orderer` },
  });
  if (error || !data.user) throw new Error(`auth.user 作成失敗: ${error?.message ?? '空応答'}`);

  // handle_new_user トリガで投入された customers 行の id を逆引き
  const { data: customer, error: cErr } = await sbAdmin
    .from('customers')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .single();
  if (cErr || !customer) {
    throw new Error(`customers 行の取得に失敗（トリガ未動作？）: ${cErr?.message ?? '空応答'}`);
  }
  return { authUserId: data.user.id, customerId: customer.id as string };
};

// 注文を 1 件投入する。has_ordered は order_items を見ないため明細は不要。
const insertOrder = async (params: {
  customerId: string;
  status: 'PLACED' | 'CANCELED';
}): Promise<void> => {
  const { error } = await sbAdmin.from('orders').insert({
    id: randomUUID(),
    customer_id: params.customerId,
    status: params.status,
    total_amount: 500,
  });
  if (error) throw new Error(`orders 投入失敗: ${error.message}`);
};

describe('SupabaseOrderHistoryChecker（実 Supabase ローカル + has_ordered RPC）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const checker = new SupabaseOrderHistoryChecker(sbAdmin);

  it('PLACED 注文があれば true（cake を問わない）', async () => {
    const { authUserId, customerId } = await seedAuthUser('has');
    await insertOrder({ customerId, status: 'PLACED' });

    expect(await checker.hasOrdered(authUserId)).toBe(true);
  });

  it('CANCELED 注文しかなければ false（未利用扱い）', async () => {
    const { authUserId, customerId } = await seedAuthUser('cancel');
    await insertOrder({ customerId, status: 'CANCELED' });

    expect(await checker.hasOrdered(authUserId)).toBe(false);
  });

  it('別ユーザーの利用実績は他ユーザーに漏れない', async () => {
    const orderer = await seedAuthUser('orderer');
    const observer = await seedAuthUser('observer');
    await insertOrder({ customerId: orderer.customerId, status: 'PLACED' });

    // observer は注文していない
    expect(await checker.hasOrdered(observer.authUserId)).toBe(false);
    // orderer 本人は true
    expect(await checker.hasOrdered(orderer.authUserId)).toBe(true);
  });

  it('注文が 1 件もなければ false', async () => {
    const { authUserId } = await seedAuthUser('none');
    expect(await checker.hasOrdered(authUserId)).toBe(false);
  });
});
