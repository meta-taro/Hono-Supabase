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
// pino-pretty で整形するのは NODE_ENV=development のときだけ。
// production / staging / test は素の JSON（ログ収集基盤で機械処理する前提）。
//   ※ `!== 'production'` 方式だと staging が pretty 側に落ちて読み手が誤解するため、
//     「development のときだけ true」と明示的に書く。
//   ※ そもそも staging / production は Cloudflare Workers で動くので、この Node 専用
//     ロガーは通らない（createWorkersLogger が使われる）。それでも整合性のため厳密化。
// ---------------------------------------------------------------------------

export const createNodePinoLogger = (env: NodeJS.ProcessEnv = process.env): AppLogger => {
  const isDevelopment = env.NODE_ENV === 'development';

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
