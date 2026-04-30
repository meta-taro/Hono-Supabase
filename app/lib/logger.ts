import pino, { type Logger } from 'pino';

// テスト用に env を差し替えられるよう関数化している。
// 本番経路は末尾の logger エクスポートで process.env を渡す。
export const createLogger = (env: NodeJS.ProcessEnv = process.env): Logger => {
  // pino-pretty は worker thread を使うため、テスト/本番では JSON 出力に統一する。
  const isDevelopment = env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test';

  return pino({
    level: env.LOG_LEVEL ?? 'info',
    ...(isDevelopment
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  });
};

export const logger = createLogger();
