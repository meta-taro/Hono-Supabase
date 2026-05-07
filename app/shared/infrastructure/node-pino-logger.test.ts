import { describe, it, expect } from 'vitest';
import { createNodePinoLogger } from './node-pino-logger';

// ---------------------------------------------------------------------------
// createNodePinoLogger は Node ローカル開発専用の pino 実装。
// pino を bundle に含めると Workers 起動時に process is not defined で
// クラッシュするため、logger.ts 本体からは分離してある（node-pino-logger.ts）。
// ---------------------------------------------------------------------------

describe('createNodePinoLogger', () => {
  it('LOG_LEVEL を尊重する', () => {
    const log = createNodePinoLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
    expect(log.level).toBe('warn');
  });

  it('LOG_LEVEL 未指定なら info にフォールバックする', () => {
    const log = createNodePinoLogger({ NODE_ENV: 'test' });
    expect(log.level).toBe('info');
  });

  it('NODE_ENV=production では JSON 経路（pretty 非適用）で生成できる', () => {
    const log = createNodePinoLogger({ NODE_ENV: 'production' });
    expect(log.level).toBe('info');
  });

  it('NODE_ENV=development では pretty transport 経路で生成できる', () => {
    // pino-pretty は worker 起動を伴うが、生成自体は同期で完了する。
    const log = createNodePinoLogger({ NODE_ENV: 'development' });
    expect(log.level).toBe('info');
  });
});
