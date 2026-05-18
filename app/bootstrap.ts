import type { OpenAPIHono } from '@hono/zod-openapi';
import { createClient } from '@supabase/supabase-js';
import { createApp, type HealthDbProbe } from '@/app';
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
import { createAccessLogMiddleware } from '@/shared/http/access-log.middleware';

// Phase 9 Step 3a: /health の DB プローブ実装。
//   - anon キーで cakes を 1 行 select するだけ（RLS で public read 可能）
//   - AbortSignal.timeout(1500) で 1.5 秒以内に応答が無ければ ok:false 扱い
//   - 失敗パス（タイムアウト/HTTP エラー/接続失敗）は全て握って ok:false に丸める
//     → /health 側が 3 状態（ok | degraded | down）に振り分ける
// 仮の閾値:
//   - probe timeout    = 1500ms（Step 3b で実測ベースに調整）
//   - degraded 判定     = latency_ms > 800（app.ts 側に定義）
const PROBE_TIMEOUT_MS = 1500;

const createHealthDbProbe = (env: Env): HealthDbProbe => {
  // probe 専用 anon クライアントは bootstrap で 1 度だけ作る（per-request では作らない）。
  // /health は認証も RLS も関わらず、cakes の 1 行を見るだけなので使い回して問題ない。
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async () => {
    const start = Date.now();
    try {
      const { error } = await sb
        .from('cakes')
        .select('id')
        .limit(1)
        .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
      const latency_ms = Date.now() - start;
      return { ok: !error, latency_ms };
    } catch {
      // タイムアウト・ネットワーク不到達等。down に倒す。
      return { ok: false, latency_ms: Date.now() - start };
    }
  };
};

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
    // Phase 9 Step 1/2: 全パス（/health 含む）に通すグローバルミドルウェア。
    //   1. requestContext: requestId 採用/生成 + req スコープロガーを c.var.logger に積む
    //   2. accessLog:      入口で start を取り、出口で {status, duration_ms, userId} を
    //                      ステータス別レベル（5xx→error / 4xx→warn / 他→info）で吐く
    // 順序は厳守: accessLog は requestContext より後（c.var.logger を消費するため）。
    globalMiddlewares: [
      createRequestContextMiddleware({ baseLogger: logger }),
      createAccessLogMiddleware(),
    ],
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
    healthDbProbe: createHealthDbProbe(env),
  });
};
