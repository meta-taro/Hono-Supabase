import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Email } from '../domain/email.vo';
import { CustomerSupabaseRepository } from './customer.supabase-repository';
import { loadEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカルに対して動く」ことの確認なので、
// 起動済みの Supabase（`supabase start`）が必要。
// .env の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を vitest.config.ts が読み込み、
// loadEnv() で取得できる前提で動く。
//
// Phase 6 改定:
//   - customers の INSERT は handle_new_user トリガ経由のみ（直接 INSERT 不可）。
//   - そのためテストでは sb.auth.admin.createUser() で auth.users を作り、
//     トリガが customers 行を埋めることを利用してデータを準備する。
//   - リポジトリ自身は読み取り専用（list / findByEmail / findByAuthUserId）。

const TEST_EMAIL_DOMAIN = '@test-customer.local';

const env = loadEnv();
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// テスト用に作成した auth.users を削除すれば、ON DELETE CASCADE で
// customers 行も自動的に消える。email ドメイン目印で対象を絞る。
const cleanupTestUsers = async (): Promise<void> => {
  const { data, error } = await sbAdmin.auth.admin.listUsers({ perPage: 200 });
  if (error) {
    throw new Error(`auth.users 一覧取得に失敗: ${error.message}`);
  }
  for (const user of data.users) {
    if (user.email?.endsWith(TEST_EMAIL_DOMAIN)) {
      const del = await sbAdmin.auth.admin.deleteUser(user.id);
      if (del.error) {
        throw new Error(`auth.users 削除に失敗 (id=${user.id}): ${del.error.message}`);
      }
    }
  }
};

interface SeedResult {
  authUserId: string;
  email: string;
  name: string;
}

// auth.admin.createUser で auth.users を作る → トリガが customers を埋める。
// email_confirm: true でメール確認をスキップする（テスト即時利用のため）。
const seedAuthUser = async (params: { email: string; name: string }): Promise<SeedResult> => {
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email: params.email,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { name: params.name },
  });
  if (error || !data.user) {
    throw new Error(`auth.users の seed に失敗: ${error?.message ?? '空応答'}`);
  }
  return { authUserId: data.user.id, email: params.email, name: params.name };
};

describe('CustomerSupabaseRepository（実 Supabase ローカルに接続）', () => {
  beforeEach(cleanupTestUsers);
  afterAll(cleanupTestUsers);

  const repo = new CustomerSupabaseRepository(sbAdmin);

  describe('findByEmail()', () => {
    it('登録済みのメールアドレスで検索すると Customer を返す', async () => {
      const seed = await seedAuthUser({
        email: `findme${TEST_EMAIL_DOMAIN}`,
        name: 'find-target',
      });

      const found = await repo.findByEmail(Email.of(seed.email));

      expect(found).not.toBeNull();
      expect(found?.authUserId).toBe(seed.authUserId);
      expect(found?.email.value).toBe(seed.email);
    });

    it('未登録のメールアドレスでは null を返す', async () => {
      const found = await repo.findByEmail(Email.of(`nobody${TEST_EMAIL_DOMAIN}`));
      expect(found).toBeNull();
    });

    it('大文字で検索しても VO で正規化された値で照合される', async () => {
      const seed = await seedAuthUser({
        email: `case${TEST_EMAIL_DOMAIN}`,
        name: 'case-test',
      });

      const found = await repo.findByEmail(Email.of(`CASE${TEST_EMAIL_DOMAIN.toUpperCase()}`));

      expect(found).not.toBeNull();
      expect(found?.authUserId).toBe(seed.authUserId);
    });
  });

  describe('findByAuthUserId()', () => {
    it('登録済みの authUserId で検索すると Customer を返す', async () => {
      const seed = await seedAuthUser({
        email: `byauth${TEST_EMAIL_DOMAIN}`,
        name: 'auth-find',
      });

      const found = await repo.findByAuthUserId(seed.authUserId);

      expect(found).not.toBeNull();
      expect(found?.authUserId).toBe(seed.authUserId);
      expect(found?.email.value).toBe(seed.email);
    });

    it('未登録の authUserId では null を返す', async () => {
      const found = await repo.findByAuthUserId('00000000-0000-4000-8000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('list()', () => {
    it('保存された顧客を name 昇順で取得できる', async () => {
      await seedAuthUser({
        email: `c${TEST_EMAIL_DOMAIN}`,
        name: 'c-charlie',
      });
      await seedAuthUser({
        email: `a${TEST_EMAIL_DOMAIN}`,
        name: 'a-alpha',
      });
      await seedAuthUser({
        email: `b${TEST_EMAIL_DOMAIN}`,
        name: 'b-bravo',
      });

      const all = await repo.list();
      const testNames = all
        .map((c) => c.name)
        .filter((n) => n === 'a-alpha' || n === 'b-bravo' || n === 'c-charlie');

      expect(testNames).toEqual(['a-alpha', 'b-bravo', 'c-charlie']);
    });

    it('Repository が返す Customer は domain の不変条件を満たす（reconstruct() 経由）', async () => {
      const seed = await seedAuthUser({
        email: `reconstruct${TEST_EMAIL_DOMAIN}`,
        name: 'reconstruct-test',
      });

      const all = await repo.list();
      const reconstructed = all.find((c) => c.authUserId === seed.authUserId);

      expect(reconstructed).toBeDefined();
      expect(reconstructed?.email.value).toBe(seed.email);
      expect(reconstructed?.name).toBe(seed.name);
    });
  });
});
