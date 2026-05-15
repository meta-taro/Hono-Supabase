import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createErrorHandler } from '@/shared/http/error-handler';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import { createSilentLogger, type AppLogger } from '@/shared/infrastructure/logger';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { createCustomerRouter } from '@/modules/customers/presentation/customer.routes';
import { createOrderRouter } from '@/modules/orders/presentation/order.routes';

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

export interface AppOptions {
  rootMiddlewares: MiddlewareHandler<AppEnv>[];
  guards: AppGuards;
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
  app.get('/health', (c) => c.json({ status: 'ok', version: appVersion }));

  if (options) {
    // /v1/* 全体に通すグローバルミドルウェア。
    // optionalAuth → requestSupabase → modulesMiddleware の順で並んでいる前提。
    for (const mw of options.rootMiddlewares) {
      app.use('/v1/*', mw);
    }

    app.route('/v1/cakes', createCakeRouter({ adminGuard: options.guards.adminGuard }));
    app.route('/v1/customers', createCustomerRouter({ adminGuard: options.guards.adminGuard }));
    app.route('/v1/orders', createOrderRouter({ authGuard: options.guards.authGuard }));
  }

  app.onError(createErrorHandler(options?.logger ?? createSilentLogger()));

  return app;
};
