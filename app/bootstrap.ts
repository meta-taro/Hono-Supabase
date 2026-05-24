import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { createApp, type HealthDbProbe, type RateLimitMiddlewares } from '@/app';
import type { AppEnv } from '@/shared/http/request-context';
import type { Env } from '@/shared/http/env';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { JwksFetcherProvider } from '@/shared/infrastructure/jwks-fetcher';
import type { MetricsRecorder } from '@/shared/infrastructure/metrics';
import type { RateLimiter } from '@/shared/http/rate-limiter';
import { createModulesMiddleware } from '@/shared/composition-root';
import {
  createOptionalAuthMiddleware,
  createRequestSupabaseMiddleware,
  requireAuth,
  requireAdmin,
} from '@/shared/http/auth.middleware';
import { createRequestContextMiddleware } from '@/shared/http/request-context.middleware';
import {
  createAccessLogMiddleware,
  type AccessLogMetricsBinding,
} from '@/shared/http/access-log.middleware';
import {
  createRateLimitMiddleware,
  ipKey,
  noopRateLimitMiddleware,
  userOrIpKey,
} from '@/shared/http/rate-limit.middleware';

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
  // Phase 9 Step 4: Workers Analytics Engine 用 recorder。
  // 省略時は計測しない（Node 起点 / 最小テスト / binding 未注入時）。
  // Workers エントリ側で bindings.API_REQUESTS から
  // createAnalyticsEngineRecorder で組み立てて渡す。
  metricsRecorder?: MetricsRecorder;
  // Phase 10 Step 5: Workers Rate Limiting binding。
  //   Node / `wrangler dev` / 旧デプロイなどで未注入のキーは undefined を渡せばよい
  //   （bootstrap が noop に倒す）。binding ごとの period（10/60）は wrangler.toml で
  //   焼き込まれており、ここでは「どの period に対応する binding か」を bootstrap が
  //   知って Retry-After に反映する責務を担う。
  rateLimiters?: {
    publicRead?: RateLimiter;
    publicWrite?: RateLimiter;
    authWrite?: RateLimiter;
  };
}

// Phase 10 Step 5: Rate Limit middleware を 3 種類組み立てる。
//
//   binding が無ければ noop（=「pass-through」）に倒し、route 側の use() は常に
//   middleware を受け取れる形で統一する。route 側に optional 分岐を持ち込まない方が
//   テスト・読みやすさの両面で素直。
//
//   retryAfterSec は wrangler.toml の simple.period と必ず一致させる:
//     LIMITER_PUBLIC_READ:  period=10  → 10
//     LIMITER_PUBLIC_WRITE: period=60  → 60
//     LIMITER_AUTH_WRITE:   period=10  → 10
const buildRateLimitMiddlewares = (
  rateLimiters: BootstrapDeps['rateLimiters'],
): RateLimitMiddlewares => {
  const publicRead: MiddlewareHandler<AppEnv> = rateLimiters?.publicRead
    ? createRateLimitMiddleware({
        limiter: rateLimiters.publicRead,
        retryAfterSec: 10,
        resolveKey: ipKey,
      })
    : noopRateLimitMiddleware;

  const publicWrite: MiddlewareHandler<AppEnv> = rateLimiters?.publicWrite
    ? createRateLimitMiddleware({
        limiter: rateLimiters.publicWrite,
        retryAfterSec: 60,
        resolveKey: ipKey,
      })
    : noopRateLimitMiddleware;

  const authWrite: MiddlewareHandler<AppEnv> = rateLimiters?.authWrite
    ? createRateLimitMiddleware({
        limiter: rateLimiters.authWrite,
        retryAfterSec: 10,
        resolveKey: userOrIpKey,
      })
    : noopRateLimitMiddleware;

  return { publicRead, publicWrite, authWrite };
};

export const bootstrap = (deps: BootstrapDeps): OpenAPIHono<AppEnv> => {
  const { env, logger, jwksFetcherProvider, appVersion, metricsRecorder, rateLimiters } = deps;

  // accessLog に渡す metrics binding を組み立てる。recorder 未注入時は undefined
  // のまま渡して middleware 側でも no-op に倒す（書き込み経路を一切走らせない）。
  const accessLogMetrics: AccessLogMetricsBinding | undefined = metricsRecorder
    ? {
        recorder: metricsRecorder,
        env: env.NODE_ENV,
        app_version: appVersion ?? 'local',
      }
    : undefined;

  const rateLimitMiddlewares = buildRateLimitMiddlewares(rateLimiters);

  return createApp({
    // Phase 9 Step 1/2/4: 全パス（/health 含む）に通すグローバルミドルウェア。
    //   1. requestContext: requestId 採用/生成 + req スコープロガーを c.var.logger に積む
    //   2. accessLog:      入口で start を取り、出口で {status, duration_ms, userId} を
    //                      ステータス別レベル（5xx→error / 4xx→warn / 他→info）で吐く
    //                      + Step 4: metrics 注入時は Analytics Engine にも 1 イベント書く
    // 順序は厳守: accessLog は requestContext より後（c.var.logger を消費するため）。
    globalMiddlewares: [
      createRequestContextMiddleware({ baseLogger: logger }),
      createAccessLogMiddleware({ metrics: accessLogMetrics }),
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
    rateLimitMiddlewares,
    logger,
    appVersion,
    healthDbProbe: createHealthDbProbe(env),
  });
};
