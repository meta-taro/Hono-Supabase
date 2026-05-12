import { describe, it, expect } from 'vitest';
import { createAnonClient, createAdminClient } from './supabase';
import type { Env } from '@/shared/http/env';

// テスト用 env フィクスチャ。loadEnv() を通さず Env 型を満たした素のオブジェクト。
const fixtureEnv: Env = {
  PORT: 3010,
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'fixture-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key',
};

describe('createAnonClient', () => {
  it('SupabaseClient 形状のインスタンスを返す', () => {
    const client = createAnonClient(fixtureEnv);
    expect(client).toBeDefined();
    expect(typeof client.from).toBe('function');
    expect(client.auth).toBeDefined();
  });

  it('呼ぶたびに新しいインスタンスを返す（共有禁止）', () => {
    const a = createAnonClient(fixtureEnv);
    const b = createAnonClient(fixtureEnv);
    expect(a).not.toBe(b);
  });
});

describe('createAdminClient', () => {
  it('SupabaseClient 形状のインスタンスを返す', () => {
    const client = createAdminClient(fixtureEnv);
    expect(client).toBeDefined();
    expect(typeof client.from).toBe('function');
    expect(client.auth).toBeDefined();
  });

  it('呼ぶたびに新しいインスタンスを返す（共有禁止）', () => {
    const a = createAdminClient(fixtureEnv);
    const b = createAdminClient(fixtureEnv);
    expect(a).not.toBe(b);
  });
});

describe('anon と admin の分離', () => {
  it('別インスタンスを返す（権限の混在防止）', () => {
    const anon = createAnonClient(fixtureEnv);
    const admin = createAdminClient(fixtureEnv);
    expect(anon).not.toBe(admin);
  });
});
