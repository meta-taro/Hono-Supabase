import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Customer } from '../domain/customer';
import { Email } from '../domain/email.vo';
import { EmailAlreadyTakenError } from '../domain/customer.errors';
import { ConflictError } from '@/shared/domain/errors';
import { CustomerSupabaseRepository } from './customer.supabase-repository';
import { loadEnv } from '@/shared/http/env';

// このテストは「実 Supabase ローカルに対して動く」ことの確認なので、
// 起動済みの Supabase（`supabase start`）が必要。
// .env の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を vitest.config.ts が読み込み、
// loadEnv() で取得できる前提で動く。

// テストデータの目印。
// このプレフィックスで始まる name / email だけを掃除対象にすることで、
// seed.sql / 手動登録（Studio や Bruno 経由）のデータには絶対に触れない。
const TEST_NAME_PREFIX = '__test_customer_';
const TEST_EMAIL_DOMAIN = '@test-customer.local';

const env = loadEnv();
const sbAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// テスト目印付きの行のみを削除する。
// name と email の両軸で保険をかけ、片方だけが残ることを防ぐ。
const cleanupTestRows = async (): Promise<void> => {
  const byName = await sbAdmin
    .from('customers')
    .delete()
    .like('name', `${TEST_NAME_PREFIX}%`);
  if (byName.error) {
    throw new Error(`テストデータ（name）の掃除に失敗: ${byName.error.message}`);
  }
  const byEmail = await sbAdmin
    .from('customers')
    .delete()
    .like('email', `%${TEST_EMAIL_DOMAIN}`);
  if (byEmail.error) {
    throw new Error(`テストデータ（email）の掃除に失敗: ${byEmail.error.message}`);
  }
};

describe('CustomerSupabaseRepository（実 Supabase ローカルに接続）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const repo = new CustomerSupabaseRepository(sbAdmin);

  describe('save()', () => {
    it('Customer.create() で生成した顧客を保存できる', async () => {
      const customer = Customer.create({
        name: `${TEST_NAME_PREFIX}田中`,
        email: `tanaka${TEST_EMAIL_DOMAIN}`,
      });

      await repo.save(customer);

      const { data, error } = await sbAdmin
        .from('customers')
        .select('id, name, email')
        .eq('id', customer.id.value)
        .single();

      expect(error).toBeNull();
      expect(data).toEqual({
        id: customer.id.value,
        name: `${TEST_NAME_PREFIX}田中`,
        email: `tanaka${TEST_EMAIL_DOMAIN}`,
      });
    });

    it('同一 ID で 2 回保存すると ConflictError を投げる', async () => {
      const customer = Customer.create({
        name: `${TEST_NAME_PREFIX}id-duplicate`,
        email: `iddup${TEST_EMAIL_DOMAIN}`,
      });

      await repo.save(customer);
      await expect(repo.save(customer)).rejects.toBeInstanceOf(ConflictError);
    });

    it('別 ID でも同一 email を保存すると EmailAlreadyTakenError を投げる', async () => {
      // UNIQUE(email) 制約による 23505 を、ドメイン例外
      // EmailAlreadyTakenError（CONFLICT 体系の派生）に変換できることを確認。
      const a = Customer.create({
        name: `${TEST_NAME_PREFIX}user-a`,
        email: `same${TEST_EMAIL_DOMAIN}`,
      });
      const b = Customer.create({
        name: `${TEST_NAME_PREFIX}user-b`,
        email: `same${TEST_EMAIL_DOMAIN}`,
      });

      await repo.save(a);
      await expect(repo.save(b)).rejects.toBeInstanceOf(EmailAlreadyTakenError);
    });
  });

  describe('findByEmail()', () => {
    it('登録済みのメールアドレスで検索すると Customer を返す', async () => {
      const customer = Customer.create({
        name: `${TEST_NAME_PREFIX}find-target`,
        email: `findme${TEST_EMAIL_DOMAIN}`,
      });
      await repo.save(customer);

      const found = await repo.findByEmail(Email.of(`findme${TEST_EMAIL_DOMAIN}`));

      expect(found).not.toBeNull();
      expect(found?.id.value).toBe(customer.id.value);
      expect(found?.email.value).toBe(`findme${TEST_EMAIL_DOMAIN}`);
    });

    it('未登録のメールアドレスでは null を返す', async () => {
      const found = await repo.findByEmail(Email.of(`nobody${TEST_EMAIL_DOMAIN}`));
      expect(found).toBeNull();
    });

    it('大文字で検索しても VO で正規化された値で照合される', async () => {
      const customer = Customer.create({
        name: `${TEST_NAME_PREFIX}case-test`,
        email: `case${TEST_EMAIL_DOMAIN}`,
      });
      await repo.save(customer);

      // Email.of() が小文字化するため、入力が大文字でも見つかる。
      const found = await repo.findByEmail(Email.of(`CASE${TEST_EMAIL_DOMAIN.toUpperCase()}`));

      expect(found).not.toBeNull();
      expect(found?.id.value).toBe(customer.id.value);
    });
  });

  describe('list()', () => {
    it('保存した顧客を取得できる', async () => {
      const a = Customer.create({
        name: `${TEST_NAME_PREFIX}a-alpha`,
        email: `a${TEST_EMAIL_DOMAIN}`,
      });
      const b = Customer.create({
        name: `${TEST_NAME_PREFIX}b-bravo`,
        email: `b${TEST_EMAIL_DOMAIN}`,
      });
      await repo.save(a);
      await repo.save(b);

      const all = await repo.list();
      const testCustomers = all.filter((c) => c.name.startsWith(TEST_NAME_PREFIX));

      expect(testCustomers).toHaveLength(2);
      expect(testCustomers.map((c) => c.name)).toEqual([
        `${TEST_NAME_PREFIX}a-alpha`,
        `${TEST_NAME_PREFIX}b-bravo`,
      ]);
    });

    it('name 昇順でソートされる', async () => {
      await repo.save(
        Customer.create({
          name: `${TEST_NAME_PREFIX}c`,
          email: `c${TEST_EMAIL_DOMAIN}`,
        }),
      );
      await repo.save(
        Customer.create({
          name: `${TEST_NAME_PREFIX}a`,
          email: `a${TEST_EMAIL_DOMAIN}`,
        }),
      );
      await repo.save(
        Customer.create({
          name: `${TEST_NAME_PREFIX}b`,
          email: `b${TEST_EMAIL_DOMAIN}`,
        }),
      );

      const all = await repo.list();
      const testNames = all
        .map((c) => c.name)
        .filter((n) => n.startsWith(TEST_NAME_PREFIX));

      expect(testNames).toEqual([
        `${TEST_NAME_PREFIX}a`,
        `${TEST_NAME_PREFIX}b`,
        `${TEST_NAME_PREFIX}c`,
      ]);
    });

    it('Repository が返す Customer は domain の不変条件を満たす（reconstruct() 経由）', async () => {
      const customer = Customer.create({
        name: `${TEST_NAME_PREFIX}reconstruct`,
        email: `reconstruct${TEST_EMAIL_DOMAIN}`,
      });
      await repo.save(customer);

      const all = await repo.list();
      const reconstructed = all.find((c) => c.id.value === customer.id.value);

      expect(reconstructed).toBeDefined();
      expect(reconstructed?.id.value).toBe(customer.id.value);
      expect(reconstructed?.email.value).toBe(`reconstruct${TEST_EMAIL_DOMAIN}`);
    });
  });
});
