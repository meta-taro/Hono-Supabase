import { describe, it, expect } from 'vitest';
import { loadEnv } from '@/lib/env';

describe('loadEnv', () => {
  it('PORT 未指定時は 3010 にフォールバックする', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    expect(env.PORT).toBe(3010);
  });

  it('PORT は数値文字列を coerce してくれる', () => {
    const env = loadEnv({ PORT: '4000', NODE_ENV: 'test' });
    expect(env.PORT).toBe(4000);
  });

  it('PORT が不正値なら throw する', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow();
  });

  it('PORT が 0 以下なら throw する', () => {
    expect(() => loadEnv({ PORT: '0' })).toThrow();
  });

  it('NODE_ENV のデフォルトは development', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
  });

  it('NODE_ENV が想定外なら throw する', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow();
  });

  it('LOG_LEVEL のデフォルトは info', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('LOG_LEVEL に debug/info/warn/error を許可する', () => {
    expect(loadEnv({ LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
    expect(loadEnv({ LOG_LEVEL: 'warn' }).LOG_LEVEL).toBe('warn');
    expect(loadEnv({ LOG_LEVEL: 'error' }).LOG_LEVEL).toBe('error');
  });
});
