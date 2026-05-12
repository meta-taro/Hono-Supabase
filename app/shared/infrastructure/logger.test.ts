import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWorkersLogger, createSilentLogger } from './logger';

// Node / pino 実装は別ファイル（node-pino-logger.ts）に分離してある。
// 対応するテストは node-pino-logger.test.ts。
//
// このファイルでは Workers / silent 実装のみを検証する（pino を import しない）。

// ---------------------------------------------------------------------------
// createWorkersLogger
//   Workers ランタイムでは pino が動かないため、console.log(JSON.stringify(...))
//   ベースの軽量実装に差し替える。pino 互換の出力形式（level=数値, time, msg）
//   を維持して、ログ集約側の検索クエリを変えずに済むようにする。
// ---------------------------------------------------------------------------

describe('createWorkersLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    logSpy?.mockRestore();
  });

  const captureLog = (): ReturnType<typeof vi.spyOn> => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    return logSpy;
  };

  const lastRecord = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> => {
    const calls = spy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastArg = calls[calls.length - 1]?.[0];
    expect(typeof lastArg).toBe('string');
    return JSON.parse(lastArg as string) as Record<string, unknown>;
  };

  it('logger.level を返せる（既定値は info）', () => {
    const log = createWorkersLogger();
    expect(log.level).toBe('info');
  });

  it('options.level を尊重する', () => {
    const log = createWorkersLogger({ level: 'warn' });
    expect(log.level).toBe('warn');
  });

  it('info({ ... }, "msg") は pino 互換の JSON を console.log する', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1737000000000 });

    log.info({ orderId: 'abc' }, 'OrderPlaced');

    const rec = lastRecord(spy);
    expect(rec).toEqual({
      level: 30, // info
      time: 1737000000000,
      orderId: 'abc',
      msg: 'OrderPlaced',
    });
  });

  it('info("msg") のみの呼び出しもサポートする', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1 });

    log.info('hello');

    expect(lastRecord(spy)).toEqual({
      level: 30,
      time: 1,
      msg: 'hello',
    });
  });

  it('info({ ... }) のみ（msg なし）の呼び出しもサポートする', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1 });

    log.info({ event: 'tick' });

    expect(lastRecord(spy)).toEqual({
      level: 30,
      time: 1,
      event: 'tick',
    });
  });

  it('level よりも下位（数値が小さい）の出力は捨てる', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ level: 'warn' });

    log.debug('skipped');
    log.info('skipped too');
    log.warn('shown');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(lastRecord(spy).msg).toBe('shown');
  });

  it('level=silent のときは何も出力しない', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ level: 'silent' });

    log.fatal('nope');
    log.error('nope');

    expect(spy).not.toHaveBeenCalled();
  });

  it('error / warn / debug / trace / fatal で level 数値が pino 互換に揃う', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ level: 'trace', now: () => 1 });

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');

    const levels = spy.mock.calls.map(
      (c) => (JSON.parse(c[0] as string) as { level: number }).level,
    );
    expect(levels).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('child(bindings) は親 bindings を継承し、子側で上書き可能', () => {
    const spy = captureLog();
    const root = createWorkersLogger({
      bindings: { service: 'api', env: 'test' },
      now: () => 1,
    });
    const child = root.child({ requestId: 'req-1', env: 'override' });

    child.info({ orderId: 'abc' }, 'placed');

    expect(lastRecord(spy)).toEqual({
      level: 30,
      time: 1,
      service: 'api',
      env: 'override', // 子で上書き
      requestId: 'req-1',
      orderId: 'abc',
      msg: 'placed',
    });
  });

  it('呼び出し時 bindings は基底/子 bindings を上書きできる', () => {
    const spy = captureLog();
    const log = createWorkersLogger({
      bindings: { env: 'base' },
      now: () => 1,
    });

    log.info({ env: 'call' }, 'msg');

    expect((lastRecord(spy) as { env: string }).env).toBe('call');
  });

  // Error は message / stack / name が non-enumerable なので素朴な
  // JSON.stringify では `{}` に潰れる。pino の err serializer 互換で
  // 展開していることを保証する（本番障害解析の生命線）。
  it('Error オブジェクトを type / message / stack に展開する', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1 });

    const err = new TypeError('boom');
    log.error({ err }, 'failed');

    const rec = lastRecord(spy) as {
      err: { type: string; message: string; stack: string };
      msg: string;
    };
    expect(rec.err.type).toBe('TypeError');
    expect(rec.err.message).toBe('boom');
    expect(typeof rec.err.stack).toBe('string');
    expect(rec.err.stack).toContain('TypeError');
    expect(rec.msg).toBe('failed');
  });

  it('Error の cause を再帰的にシリアライズする', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1 });

    const root = new Error('root cause');
    const wrapped = new Error('wrapper', { cause: root });
    log.error({ err: wrapped });

    const rec = lastRecord(spy) as {
      err: { message: string; cause: { message: string; type: string } };
    };
    expect(rec.err.message).toBe('wrapper');
    expect(rec.err.cause.message).toBe('root cause');
    expect(rec.err.cause.type).toBe('Error');
  });

  it('Error 派生クラスのカスタムプロパティを保持する', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1 });

    class DomainError extends Error {
      constructor(
        message: string,
        public readonly code: string,
      ) {
        super(message);
      }
    }
    log.error({ err: new DomainError('not found', 'NOT_FOUND') });

    const rec = lastRecord(spy) as {
      err: { type: string; message: string; code: string };
    };
    expect(rec.err.type).toBe('DomainError');
    expect(rec.err.message).toBe('not found');
    expect(rec.err.code).toBe('NOT_FOUND');
  });

  it('非 Error の値はそのまま素通しする', () => {
    const spy = captureLog();
    const log = createWorkersLogger({ now: () => 1 });

    log.info({ count: 42, ok: true, items: ['a', 'b'] });

    const rec = lastRecord(spy);
    expect(rec).toMatchObject({ count: 42, ok: true, items: ['a', 'b'] });
  });
});

// ---------------------------------------------------------------------------
// createSilentLogger
//   テスト用の no-op 実装。何を呼んでも副作用ゼロ・例外なし。
// ---------------------------------------------------------------------------

describe('createSilentLogger', () => {
  it('全レベル呼び出しても副作用ゼロ（console.log を呼ばない）', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const log = createSilentLogger();
      log.fatal({ x: 1 }, 'f');
      log.error('e');
      log.warn({ x: 1 });
      log.info('i');
      log.debug('d');
      log.trace('t');
      log.child({ k: 'v' }).info('ignored');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('level は "silent"', () => {
    expect(createSilentLogger().level).toBe('silent');
  });

  it('child() は同じく silent な AppLogger を返す', () => {
    const child = createSilentLogger().child({ k: 'v' });
    expect(child.level).toBe('silent');
  });
});
