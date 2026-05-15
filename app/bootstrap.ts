import type { OpenAPIHono } from '@hono/zod-openapi';
import { createApp } from '@/app';
import type { AppEnv } from '@/shared/http/request-context';
import type { Env } from '@/shared/http/env';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { JwksFetcherProvider } from '@/shared/infrastructure/jwks-fetcher';
import { createModulesMiddleware } from '@/shared/composition-root';
import {
  createOptionalAuthMiddleware,
  createRequestSupabaseMiddleware,
  requireAuth,
  requireAdmin,
} from '@/shared/http/auth.middleware';
import { createRequestContextMiddleware } from '@/shared/http/request-context.middleware';

// ---------------------------------------------------------------------------
// bootstrap = ランタイム非依存のアプリ組み立て関数。
//
// Node 起点（index.node.ts）と Cloudflare Workers 起点（index.workers.ts）の
// 両方から呼ぶ。違いは「deps をどう用意するか」だけなので、ここでは差を吸収せずに
// 受け取った deps をそのまま middleware に注入する。
//
// Phase 7 の DI ポイント:
//   - logger:              Node = pino / Workers = console.log JSON 実装
//   - jwksFetcherProvider: ctx を受けて per-request の fetcher を返す関数
//                            Node = (_ctx) => createNodeJwksFetcher()
//                            Workers = (ctx) => createWorkersJwksFetcher({ ctx, cache, fetch })
//   - env:                 Node = process.env / Workers = c.env から loadEnv した結果
// ---------------------------------------------------------------------------

export interface BootstrapDeps {
  env: Env;
  logger: AppLogger;
  jwksFetcherProvider: JwksFetcherProvider;
  // /health に晒すデプロイ識別子。Workers = version_metadata のバージョン ID、
  // Node = 'local'。省略時は createApp 側で 'local' になる。
  appVersion?: string;
}

export const bootstrap = (deps: BootstrapDeps): OpenAPIHono<AppEnv> => {
  const { env, logger, jwksFetcherProvider, appVersion } = deps;

  return createApp({
    // Phase 9 Step 1: 入口で requestId 確立 + req スコープロガーを c.var.logger に積む。
    // /health にも適用される（外形監視からのリクエストも追跡できる）。
    globalMiddlewares: [createRequestContextMiddleware({ baseLogger: logger })],
    rootMiddlewares: [
      createOptionalAuthMiddleware({ env, jwksFetcherProvider }),
      createRequestSupabaseMiddleware(env),
      createModulesMiddleware({ env, logger }),
    ],
    guards: {
      adminGuard: [requireAuth(), requireAdmin()],
      authGuard: [requireAuth()],
    },
    logger,
    appVersion,
  });
};
