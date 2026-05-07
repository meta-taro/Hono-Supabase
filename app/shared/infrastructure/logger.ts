// ---------------------------------------------------------------------------
// AppLogger interface
//   ランタイム非依存のロガー抽象。Node では pino、Cloudflare Workers では
//   console.log(JSON.stringify(...)) ベースの実装で差し替える。
//
//   設計方針:
//     - pino の `logger.info({ ...bindings }, 'message')` 呼び出しスタイルを
//       踏襲する（既存の呼び出しコードを書き換え不要にするため）。
//     - level / child は pino 互換の最小集合のみ公開する。
//     - 実装側のクラスや具象は隠蔽する（依存方向は AppLogger interface のみ）。
//
//   重要: このファイルからは pino を import しない。Workers の bundle に
//   pino が混入すると `process is not defined` で起動時クラッシュする。
//   Node 用 pino 実装は node-pino-logger.ts に分離してある。
// ---------------------------------------------------------------------------

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

// 構造化ログの bindings は任意のオブジェクト形を許容する（pino と同じ緩さ）。
//   - Record<string, unknown> に絞ると、interface 型（Index signature 持たない）が
//     代入不可になり、呼び出し側の型を狭めすぎる弊害があるため `object` を採用。
//   - `null` だけは弾きたいので素の object（{} ではなく）を使う。
type LogBindings = object;

export interface AppLogger {
  level: LogLevel | string;

  fatal(message: string): void;
  fatal(bindings: LogBindings, message?: string): void;

  error(message: string): void;
  error(bindings: LogBindings, message?: string): void;

  warn(message: string): void;
  warn(bindings: LogBindings, message?: string): void;

  info(message: string): void;
  info(bindings: LogBindings, message?: string): void;

  debug(message: string): void;
  debug(bindings: LogBindings, message?: string): void;

  trace(message: string): void;
  trace(bindings: LogBindings, message?: string): void;

  child(bindings: LogBindings): AppLogger;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers 用 console-based 実装
//   Workers では pino が動かない（worker thread / fs / pino-pretty が使えない）ため、
//   console.log(JSON.stringify(...)) で構造化ログを吐く軽量実装に差し替える。
//
//   出力形式は pino 互換に揃える:
//     {"level":30,"time":1737000000000,"msg":"...","customerId":"..."}
//   - level は pino の数値表現（trace=10, debug=20, info=30, warn=40, error=50, fatal=60）
//   - time は ms epoch
//   - msg は文字列
//   - bindings はトップレベルにマージ
//   これにより Cloudflare Logs / Datadog 等で pino と同じ検索クエリが使える。
//
//   なぜ console.log なのか:
//     Workers の標準出力は console.* が wrangler tail / Cloudflare Logs に流れる
//     唯一の経路。console.error は stderr 相当として扱われるサービスもあるが、
//     構造化 JSON では level フィールドで判別できるので console.log に統一する。
// ---------------------------------------------------------------------------

const LEVEL_NUMBERS: Record<Exclude<LogLevel, 'silent'>, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

interface WorkersLoggerOptions {
  level?: LogLevel;
  // 子ロガーが上から継承する bindings
  bindings?: object;
  // 時刻ソース（テストで固定するために差し替え可能）
  now?: () => number;
}

export const createWorkersLogger = (
  options: WorkersLoggerOptions = {},
): AppLogger => {
  const level: LogLevel = options.level ?? 'info';
  const baseBindings = options.bindings ?? {};
  const now = options.now ?? Date.now;

  // 設定 level よりも下位（数値が小さい）の出力は捨てる。
  const threshold = level === 'silent' ? Infinity : LEVEL_NUMBERS[level];

  const log = (
    levelName: Exclude<LogLevel, 'silent'>,
    a: object | string,
    b?: string,
  ): void => {
    const levelNumber = LEVEL_NUMBERS[levelName];
    if (levelNumber < threshold) return;

    // pino 互換の呼び出しスタイル:
    //   logger.info('msg')                → a=string, b=undefined
    //   logger.info({ foo: 1 }, 'msg')    → a=object, b=string
    //   logger.info({ foo: 1 })           → a=object, b=undefined
    const isObjectFirst = typeof a === 'object' && a !== null;
    const bindings = isObjectFirst ? a : {};
    const msg = isObjectFirst ? b : (a as string);

    const record = {
      level: levelNumber,
      time: now(),
      ...baseBindings,
      ...bindings,
      ...(msg !== undefined ? { msg } : {}),
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  };

  const self: AppLogger = {
    level,
    fatal: (a: object | string, b?: string) => log('fatal', a, b),
    error: (a: object | string, b?: string) => log('error', a, b),
    warn: (a: object | string, b?: string) => log('warn', a, b),
    info: (a: object | string, b?: string) => log('info', a, b),
    debug: (a: object | string, b?: string) => log('debug', a, b),
    trace: (a: object | string, b?: string) => log('trace', a, b),
    child: (childBindings: object) =>
      createWorkersLogger({
        level,
        bindings: { ...baseBindings, ...childBindings },
        now,
      }),
  };
  return self;
};

// ---------------------------------------------------------------------------
// テスト用 silent ロガー
//   pino を import せずに AppLogger を満たす no-op 実装を返す。
//   どこにも出力しない（捨てる）ため、テスト出力を汚さない。
//   AppLogger interface の振る舞いを最小限に保つ「リファレンス実装」も兼ねる。
// ---------------------------------------------------------------------------

export const createSilentLogger = (): AppLogger => {
  const noop = (): void => undefined;
  const self: AppLogger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => self,
  };
  return self;
};

