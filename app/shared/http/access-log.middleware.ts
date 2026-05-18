import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { AppEnv } from '@/shared/http/request-context';
import type { MetricsRecorder } from '@/shared/infrastructure/metrics';

// ---------------------------------------------------------------------------
// accessLogMiddleware (Phase 9 Step 2 + Step 4)
//   1 リクエスト = 1 行のアクセスログを req スコープロガー経由で吐く。
//   Step 4 で同じタイミングに Workers Analytics Engine へのメトリクス書き込みを追加。
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
//   Step 4: メトリクス書き込み:
//     - options.metrics 注入時のみ Analytics Engine に 1 データポイント書く
//       （binding 未バインドの Node ローカル / テストでは options を渡さない or
//       noop recorder を渡す）
//     - route は c.req.routePath（Hono が正規化した「ハンドラに登録されたパス」、
//       例 '/v1/orders/:id'）を使う。生 path だと UUID 分カーディナリティ爆発する
//     - 未マッチ経路（404）は routePath が空 / undefined になりうるので '/unknown' に倒す
//
//   設置位置 (bootstrap):
//     globalMiddlewares で requestContextMiddleware の直後に並べる。
//     入口で start = Date.now() を取り、await next() の後にステータスを読む。
//     /health にも適用される（外形監視からの叩きも duration が観測できる）。
// ---------------------------------------------------------------------------

const isClientError = (status: number): boolean => status >= 400 && status < 500;
const isServerError = (status: number): boolean => status >= 500;

// metrics binding をひとまとめにする理由:
//   recorder 単体だと「どの env / どの app_version からの書き込みか」が
//   Analytics Engine 側で分からなくなる。bootstrap 時に固定値が決まるので、
//   middleware に渡すときも 1 つの塊として渡す方が呼び出し側もシンプル。
export interface AccessLogMetricsBinding {
  recorder: MetricsRecorder;
  env: string;
  app_version: string;
}

export interface AccessLogOptions {
  metrics?: AccessLogMetricsBinding;
}

export const createAccessLogMiddleware = (
  options: AccessLogOptions = {},
): MiddlewareHandler<AppEnv> => {
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
    const duration_ms = Date.now() - start;
    const userId = c.get('user')?.id;
    const bindings = {
      status,
      duration_ms,
      ...(userId !== undefined ? { userId } : {}),
    };

    if (isServerError(status)) {
      logger.error(bindings, 'request completed');
    } else if (isClientError(status)) {
      logger.warn(bindings, 'request completed');
    } else {
      logger.info(bindings, 'request completed');
    }

    // Step 4: Workers Analytics Engine へのメトリクス書き込み（注入時のみ）。
    // writeDataPoint は fire-and-forget なのでレスポンス遅延に乗らない。
    //
    // routePath(c, -1) で「マッチしたハンドラルートのパス」を取得する。
    //   - middleware 経由 (`app.use('*', ...)`) で素の routePath(c) を呼ぶと
    //     ミドルウェア自身のルート（'*'）が返ってしまう。-1 で末尾＝最も内側の
    //     ハンドラのルート（例 '/v1/orders/:id'）を取る。
    //   - 未マッチ経路（404）では空文字 / undefined になりうるので '/unknown' に倒す。
    if (options.metrics) {
      const route = routePath(c, -1) || '/unknown';
      options.metrics.recorder.recordRequest({
        method: c.req.method,
        route,
        status,
        duration_ms,
        env: options.metrics.env,
        app_version: options.metrics.app_version,
      });
    }
  };
};
