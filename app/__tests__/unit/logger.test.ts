import { describe, it, expect } from 'vitest';
import { createLogger } from '@/lib/logger';

describe('createLogger', () => {
  it('LOG_LEVEL を尊重する', () => {
    const log = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
    expect(log.level).toBe('warn');
  });

  it('LOG_LEVEL 未指定なら info にフォールバックする', () => {
    const log = createLogger({ NODE_ENV: 'test' });
    expect(log.level).toBe('info');
  });

  it('NODE_ENV=production では JSON 経路（pretty 非適用）で生成できる', () => {
    const log = createLogger({ NODE_ENV: 'production' });
    expect(log.level).toBe('info');
  });

  it('NODE_ENV=development では pretty transport 経路で生成できる', () => {
    // pino-pretty は worker 起動を伴うが、生成自体は同期で完了する。
    const log = createLogger({ NODE_ENV: 'development' });
    expect(log.level).toBe('info');
  });
});
