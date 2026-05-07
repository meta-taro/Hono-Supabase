import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { errorHandler } from '@/shared/http/error-handler';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppEnv } from '@/shared/http/request-context';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { createCustomerRouter } from '@/modules/customers/presentation/customer.routes';
import { createOrderRouter } from '@/modules/orders/presentation/order.routes';

// ---------------------------------------------------------------------------
// Phase 6: createApp はミドルウェアを「composable な配列」として受け取る。
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
}

export const createApp = (options?: AppOptions): OpenAPIHono<AppEnv> => {
  const app = createOpenAPIHono<AppEnv>();

  // /health は非バージョン・認証不要（CLAUDE.md API 設計）。
  app.get('/health', (c) => c.json({ status: 'ok' }));

  if (options) {
    // /v1/* 全体に通すグローバルミドルウェア。
    // optionalAuth → requestSupabase → modulesMiddleware の順で並んでいる前提。
    for (const mw of options.rootMiddlewares) {
      app.use('/v1/*', mw);
    }

    app.route(
      '/v1/cakes',
      createCakeRouter({ adminGuard: options.guards.adminGuard }),
    );
    app.route(
      '/v1/customers',
      createCustomerRouter({ adminGuard: options.guards.adminGuard }),
    );
    app.route(
      '/v1/orders',
      createOrderRouter({ authGuard: options.guards.authGuard }),
    );
  }

  app.onError(errorHandler);

  return app;
};
