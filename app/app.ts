import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createErrorHandler } from '@/shared/http/error-handler';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import { createSilentLogger, type AppLogger } from '@/shared/infrastructure/logger';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { createCustomerRouter } from '@/modules/customers/presentation/customer.routes';
import { createOrderRouter } from '@/modules/orders/presentation/order.routes';

// Phase 9 Step 3a: /health の DB プローブ結果。
//   ok        = REST 応答が成功した
//   latency_ms = プローブにかかった所要時間（プローブ関数が start→end で実測）
// プローブ関数自身がタイムアウト/例外をハンドリングして「失敗 = ok:false」に丸める。
// /health 側はこの結果を 3 状態（ok | degraded | down）に振り分ける責務のみを持つ。
export interface HealthDbProbeResult {
  ok: boolean;
  latency_ms: number;
}

export type HealthDbProbe = () => Promise<HealthDbProbeResult>;

// /health が公開する状態。
//   ok       = DB 到達 + latency が閾値以下（正常）
//   degraded = DB 到達したが latency が閾値超過（劣化警告。HTTP は 200 のまま）
//   down     = DB 到達失敗（タイムアウト or エラー）。HTTP 503 で uptime monitor に拾わせる
export type HealthStatus = 'ok' | 'degraded' | 'down';

// degraded の閾値（仮置き）。Phase 9 Step 3b で実測ベースに調整予定。
const DEGRADED_LATENCY_MS = 800;

// ---------------------------------------------------------------------------
// Phase 6 / Phase 9 Step 1: createApp はミドルウェアを「composable な配列」として受け取る。
//   - globalMiddlewares: /health を含む全パスに通す（Phase 9 Step 1 で追加）
//       本番:    [requestContextMiddleware]
//       /health にも requestId / req スコープロガーを行き渡らせるため /v1/* ではなく `*`。
//   - rootMiddlewares: /v1/* に通すグローバルミドルウェア
//       本番:    [optionalAuth, requestSupabase, modulesMiddleware]
//       テスト:  [fakeAuth(user), requestSupabase, modulesMiddleware] 等で差し替え
//   - guards.adminGuard: 管理者専用ルートに適用（[requireAuth, requireAdmin] が標準）
//   - guards.authGuard:  認証必須ルート全般に適用（[requireAuth] が標準）
//
// modules を引数として受け取らない理由:
//   sb（リクエストごとの Supabase クライアント）から組み立てる必要があり、
//   composition-root の modulesMiddleware が c.var.modules に積む形に変えた。
//   routes 層は c.get('modules') から controller を取得する。
//
// modules を optional にしている理由:
//   引数なし呼び出し（health.test.ts 互換）では /health のみを持つ最小 app になる。
// ---------------------------------------------------------------------------

export interface AppGuards {
  adminGuard: MiddlewareHandler<AppEnv>[];
  authGuard: MiddlewareHandler<AppEnv>[];
}

// Phase 10 Step 5: 各 router に流し込む Rate Limit ミドルウェアの束。
//   publicRead   GET 系・認証不要         IP キー    (LIMITER_PUBLIC_READ:  100/10s)
//   publicWrite  POST 系・認証不要         IP キー    (LIMITER_PUBLIC_WRITE: 5/60s)
//   authWrite    認証必須（read/write 双方） user キー (LIMITER_AUTH_WRITE:   10/10s)
//
// 命名は wrangler.toml 側の binding 名と一致させて運用混乱を避ける。authWrite は名前に
// "write" を含むが、Step 5 ではユーザ単位 quota を要する authenticated 全般（自分の注文
// 一覧の GET 系を含む）をここに乗せている — 増やすときは bindings を追加する。
export interface RateLimitMiddlewares {
  publicRead: MiddlewareHandler<AppEnv>;
  publicWrite: MiddlewareHandler<AppEnv>;
  authWrite: MiddlewareHandler<AppEnv>;
}

export interface AppOptions {
  rootMiddlewares: MiddlewareHandler<AppEnv>[];
  guards: AppGuards;
  // Phase 10 Step 5: 各 router に流し込む Rate Limit middleware の束（optional）。
  //   未指定 → 何も適用しない（最小 health.test.ts 用の build path / fakeAuth 経路）。
  //   bootstrap 経由の本番組み立てでは buildRateLimitMiddlewares() の結果が常に入る。
  rateLimitMiddlewares?: RateLimitMiddlewares;
  // Phase 9 Step 1: /health 含む全パスに通すミドルウェア。
  // requestContextMiddleware（requestId 採用 / 生成 + req スコープロガー）を載せる前提。
  globalMiddlewares?: MiddlewareHandler<AppEnv>[];
  // onError ハンドラに渡す logger。省略時は silent（テストで明示注入したい場合のみ
  // 指定を推奨）。Phase 7 で error-handler を factory 化したことに伴う追加引数。
  // Phase 9 Step 1 以降は c.get('logger') があればそちらを優先（fallback として残す）。
  logger?: AppLogger;
  // /health が晒すデプロイ識別子。Workers では version_metadata バインディング由来の
  // バージョン ID（index.workers.ts が cold start 時に bindings から読んで渡す）。
  // Node / テストでは 'local' 等。これにより段階展開（カナリア）中にどのバージョンが
  // 応答したかをクライアント側（curl ループ等）から観察できる。
  appVersion?: string;
  // /health の DB プローブ。省略時は DB を触らない最小 /health（テスト互換）。
  // bootstrap 経由の本番組み立てでは Supabase REST を AbortSignal.timeout で叩く実装が
  // 注入される。テストでは fake probe で 4 状態を網羅する。
  healthDbProbe?: HealthDbProbe;
}

export const createApp = (options?: AppOptions): OpenAPIHono<AppEnv> => {
  const app = createOpenAPIHono();

  const appVersion = options?.appVersion ?? 'local';

  // Phase 9 Step 1: /health より先に登録することで /health にも requestId と
  // req スコープロガーが行き渡る（外形監視・uptime monitor からの叩きもログ追跡可能）。
  if (options?.globalMiddlewares) {
    for (const mw of options.globalMiddlewares) {
      app.use('*', mw);
    }
  }

  // /health は非バージョン・認証不要（CLAUDE.md API 設計）。
  // Phase 9 Step 3a: probe 注入時は 3 状態（ok / degraded / down）+ db フィールド付き。
  //   - ok       → HTTP 200
  //   - degraded → HTTP 200（DB は応答したが latency 超過。アラートではなく観察用）
  //   - down     → HTTP 503（外形監視を pager に乗せるため明確に異常側へ倒す）
  // probe 省略時は backward-compat の {status:'ok', version} のみ（最小 health.test.ts 互換）。
  const probe = options?.healthDbProbe;
  if (probe) {
    app.get('/health', async (c) => {
      const db = await probe();
      const status: HealthStatus = !db.ok
        ? 'down'
        : db.latency_ms > DEGRADED_LATENCY_MS
          ? 'degraded'
          : 'ok';
      const httpStatus = status === 'down' ? 503 : 200;
      return c.json({ status, version: appVersion, db }, httpStatus);
    });
  } else {
    app.get('/health', (c) => c.json({ status: 'ok', version: appVersion }));
  }

  if (options) {
    // /v1/* 全体に通すグローバルミドルウェア。
    // optionalAuth → requestSupabase → modulesMiddleware の順で並んでいる前提。
    for (const mw of options.rootMiddlewares) {
      app.use('/v1/*', mw);
    }

    const rl = options.rateLimitMiddlewares;
    app.route(
      '/v1/cakes',
      createCakeRouter({ adminGuard: options.guards.adminGuard, rateLimits: rl }),
    );
    app.route(
      '/v1/customers',
      createCustomerRouter({ adminGuard: options.guards.adminGuard, rateLimits: rl }),
    );
    app.route(
      '/v1/orders',
      createOrderRouter({ authGuard: options.guards.authGuard, rateLimits: rl }),
    );
  }

  app.onError(createErrorHandler(options?.logger ?? createSilentLogger()));

  return app;
};
