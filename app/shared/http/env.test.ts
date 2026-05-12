import { describe, it, expect } from 'vitest';
import { loadEnv } from './env';

// Supabase 系は required になったので、各テストで最低限の値を渡すフィクスチャ。
// このフィクスチャを起点にしてバリデーション挙動だけをテストする。
const baseEnv = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  describe('PORT', () => {
    it('未指定時は 3010 にフォールバックする', () => {
      const env = loadEnv({ ...baseEnv, NODE_ENV: 'test' });
      expect(env.PORT).toBe(3010);
    });

    it('数値文字列を coerce してくれる', () => {
      const env = loadEnv({ ...baseEnv, PORT: '4000', NODE_ENV: 'test' });
      expect(env.PORT).toBe(4000);
    });

    it('不正値なら throw する', () => {
      expect(() => loadEnv({ ...baseEnv, PORT: 'abc' })).toThrow();
    });

    it('0 以下なら throw する', () => {
      expect(() => loadEnv({ ...baseEnv, PORT: '0' })).toThrow();
    });
  });

  describe('NODE_ENV', () => {
    it('デフォルトは development', () => {
      const env = loadEnv(baseEnv);
      expect(env.NODE_ENV).toBe('development');
    });

    it('staging を受理する（Cloudflare Workers の [env.staging] 用）', () => {
      const env = loadEnv({ ...baseEnv, NODE_ENV: 'staging' });
      expect(env.NODE_ENV).toBe('staging');
    });

    it('production / test も受理する', () => {
      expect(loadEnv({ ...baseEnv, NODE_ENV: 'production' }).NODE_ENV).toBe(
        'production',
      );
      expect(loadEnv({ ...baseEnv, NODE_ENV: 'test' }).NODE_ENV).toBe('test');
    });

    it('想定外の値なら throw する', () => {
      expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'qa' })).toThrow();
    });
  });

  describe('LOG_LEVEL', () => {
    it('デフォルトは info', () => {
      const env = loadEnv({ ...baseEnv, NODE_ENV: 'test' });
      expect(env.LOG_LEVEL).toBe('info');
    });

    it('debug/info/warn/error を許可する', () => {
      expect(loadEnv({ ...baseEnv, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
      expect(loadEnv({ ...baseEnv, LOG_LEVEL: 'warn' }).LOG_LEVEL).toBe('warn');
      expect(loadEnv({ ...baseEnv, LOG_LEVEL: 'error' }).LOG_LEVEL).toBe('error');
    });
  });

  describe('SUPABASE_URL', () => {
    it('正しい URL なら受理する', () => {
      const env = loadEnv(baseEnv);
      expect(env.SUPABASE_URL).toBe('http://localhost:54321');
    });

    it('未指定なら throw する', () => {
      const { SUPABASE_URL: _omit, ...rest } = baseEnv;
      expect(() => loadEnv(rest)).toThrow();
    });

    it('URL 形式でなければ throw する', () => {
      expect(() => loadEnv({ ...baseEnv, SUPABASE_URL: 'not-a-url' })).toThrow();
    });
  });

  describe('SUPABASE_ANON_KEY', () => {
    it('未指定なら throw する', () => {
      const { SUPABASE_ANON_KEY: _omit, ...rest } = baseEnv;
      expect(() => loadEnv(rest)).toThrow();
    });

    it('空文字なら throw する', () => {
      expect(() => loadEnv({ ...baseEnv, SUPABASE_ANON_KEY: '' })).toThrow();
    });
  });

  describe('SUPABASE_SERVICE_ROLE_KEY', () => {
    it('未指定なら throw する', () => {
      const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...rest } = baseEnv;
      expect(() => loadEnv(rest)).toThrow();
    });

    it('空文字なら throw する', () => {
      expect(() => loadEnv({ ...baseEnv, SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow();
    });
  });
});
