import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/shared/http/request-context';

// ---------------------------------------------------------------------------
// accessLogMiddleware (Phase 9 Step 2)
//   1 リクエスト = 1 行のアクセスログを req スコープロガー経由で吐く。
//
//   何を残すか:
//     - status:      レスポンスの HTTP ステータス
//     - duration_ms: 入口 (start) から出口 (next() 後) までの経過時間
//     - userId:      認証済みなら auth.users.id（c.var.user.id）。未認証では省略
//   ※ method / path / requestId は req スコープロガーの child binding に既に
//     乗っているため、ここでは重複して出さない（pino と同様の二重出力回避）。
//
//   なぜ Hono 標準 logger() を使わないか:
//     - 標準は console.log にプレーンテキストで吐くため、Cloudflare Logs /
//       Datadog で structured 検索 (status>=500 等) ができない
//     - 既に requestContextMiddleware で「requestId 付き構造化ロガー」を
//       c.var.logger に積んでいるので、それを経由すれば 1 リクエスト分の
//       ログが requestId=xxx で grep 可能 (Step 1 のセット運用)
//
//   ステータス別の出し分け:
//     - 5xx は障害として error レベル（pager / アラート対象）
//     - 4xx は警告として warn レベル（バリデーション / 認証エラー等の正常な拒否）
//     - 2xx/3xx は info レベル（通常運用ログ）
//
//   設置位置 (bootstrap):
//     globalMiddlewares で requestContextMiddleware の直後に並べる。
//     入口で start = Date.now() を取り、await next() の後にステータスを読む。
//     /health にも適用される（外形監視からの叩きも duration が観測できる）。
// ---------------------------------------------------------------------------

const isClientError = (status: number): boolean => status >= 400 && status < 500;
const isServerError = (status: number): boolean => status >= 500;

export const createAccessLogMiddleware = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const start = Date.now();

    await next();

    // logger が未挿入の経路（requestContextMiddleware を入れていない最小テスト app 等）
    // ではアクセスログを出さない。req スコープロガーが乗っている前提の運用なので、
    // ここで fallback logger を import すると逆に「裸の console / pino を Workers
    // バンドルに混ぜる」リスクが出るため。
    const logger = c.get('logger');
    if (!logger) return;

    const status = c.res.status;
    const userId = c.get('user')?.id;
    const bindings = {
      status,
      duration_ms: Date.now() - start,
      ...(userId !== undefined ? { userId } : {}),
    };

    if (isServerError(status)) {
      logger.error(bindings, 'request completed');
    } else if (isClientError(status)) {
      logger.warn(bindings, 'request completed');
    } else {
      logger.info(bindings, 'request completed');
    }
  };
};
