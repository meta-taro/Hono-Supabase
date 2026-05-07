import pino, { type Logger as PinoLogger } from 'pino';
import type { AppLogger } from './logger';

// ---------------------------------------------------------------------------
// Node 用 pino 実装。
//
// このファイルは「Node ローカル開発専用」に物理的に隔離する:
//   - logger.ts は Workers の bundle に載るため、pino を import すると
//     `process is not defined` で起動時クラッシュする
//   - createNodePinoLogger を別ファイルにし、index.node.ts からのみ import すれば
//     Workers の wrangler bundle には pino が一切混入しない（tree shaking より確実）
//
// pino の Logger 型はそのまま AppLogger を満たす（API が一致するため）。
// ローカル開発（NODE_ENV=development）時は pino-pretty で整形、それ以外は素の JSON。
// ---------------------------------------------------------------------------

export const createNodePinoLogger = (
  env: NodeJS.ProcessEnv = process.env,
): AppLogger => {
  const isDevelopment = env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test';

  const pinoLogger: PinoLogger = pino({
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

  return pinoLogger;
};
