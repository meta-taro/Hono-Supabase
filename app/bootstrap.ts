import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createClient } from '@supabase/supabase-js';
import {
  createApp,
  type HealthDbProbe,
  type IdempotencyMiddlewares,
  type RateLimitMiddlewares,
} from '@/app';
import type { AppEnv } from '@/shared/http/request-context';
import type { Env } from '@/shared/http/env';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { JwksFetcherProvider } from '@/shared/infrastructure/jwks-fetcher';
import type { MetricsRecorder } from '@/shared/infrastructure/metrics';
import type { RateLimiter } from '@/shared/http/rate-limiter';
import type { IdempotencyStore } from '@/shared/infrastructure/idempotency-store';
import type { EventPublisher } from '@/shared/application/event-publisher';
import { createAdminClient } from '@/shared/infrastructure/supabase';
import { SupabaseWebhookSubscriptionRepository } from '@/modules/webhooks/infrastructure/webhook-subscription.supabase-repository';
import { SupabaseWebhookDeliveryRepository } from '@/modules/webhooks/infrastructure/webhook-delivery.supabase-repository';
import { createWebhookEventPublisher } from '@/shared/infrastructure/webhook-event-publisher';
import { createFetchWebhookDispatcher } from '@/shared/infrastructure/webhook-dispatcher';
import {
  createWebhookDispatchMiddleware,
  noopWebhookDispatchMiddleware,
} from '@/shared/http/webhook-dispatch.middleware';
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
import {
  createIdempotencyMiddleware,
  ipOwner,
  noopIdempotencyMiddleware,
  userOwner,
} from '@/shared/http/idempotency.middleware';

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
  // Phase 10 Step 6: Idempotency-Key 永続化ストア。
  //   未注入時は noop middleware に倒し、各 POST が「Idempotency-Key 不要」な
  //   経路に戻る（テスト最小経路 / wrangler dev で binding 未準備のとき）。
  //   本番（Workers）は admin SupabaseClient + SupabaseIdempotencyStore を渡す。
  idempotencyStore?: IdempotencyStore;
  // Phase 10 Step 7: Webhook 配信用の fetch 実装。
  //   Workers では globalThis.fetch を渡し、リクエストごとに c.executionCtx.waitUntil
  //   で 1 ラウンドの delivery を片付ける（リクエスト駆動 retry）。
  //   Node ローカル / テスト最小経路では未指定で OK（dispatch middleware は noop に倒す）。
  //   未指定でも EventPublisher 側（行を enqueue するだけ）は admin sb から組み立てるため、
  //   サブスクリプションが登録されていれば webhook_deliveries 行は溜まっていく。
  //   actual な HTTP 配信ループは Workers でしか走らないが、運用上は問題ない。
  webhookFetcher?: typeof fetch;
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

// Phase 10 Step 6: Idempotency middleware を 3 種類組み立てる。
//
//   scope はエンドポイントごとに固有名前空間を切るための文字列。'POST /v1/orders' のように
//   HTTP method + path で命名し、運用ログ / DB 行を見たときに何のエンドポイントか即座に
//   分かるようにする。owner は orders/cakes が認証必須なので userOwner、customers は
//   サインアップ（未認証）のため ipOwner を割り当てる。
//
//   store 未注入時は全 endpoint で noop に倒す（route 側は常に middleware を受け取る前提を保つ）。
const buildIdempotencyMiddlewares = (store?: IdempotencyStore): IdempotencyMiddlewares => {
  if (!store) {
    return {
      orders: noopIdempotencyMiddleware,
      cakes: noopIdempotencyMiddleware,
      customers: noopIdempotencyMiddleware,
      webhooks: noopIdempotencyMiddleware,
    };
  }
  return {
    orders: createIdempotencyMiddleware({
      store,
      scope: 'POST /v1/orders',
      resolveOwner: userOwner,
    }),
    cakes: createIdempotencyMiddleware({
      store,
      scope: 'POST /v1/cakes',
      resolveOwner: userOwner,
    }),
    customers: createIdempotencyMiddleware({
      store,
      scope: 'POST /v1/customers',
      resolveOwner: ipOwner,
    }),
    webhooks: createIdempotencyMiddleware({
      store,
      scope: 'POST /v1/webhooks/subscriptions',
      resolveOwner: userOwner,
    }),
  };
};

// Phase 10 Step 7: Webhook 副系の組み立て。
//   - admin SupabaseClient で subscription / delivery repo を作り、
//     EventPublisher（PlaceOrderUseCase に注入される）と
//     dispatch middleware（リクエスト後に retry ループ 1 ラウンド）を生やす。
//   - webhookFetcher が無ければ dispatch middleware は noop に倒す。
//     publisher はそれでも実体（行を enqueue する）にしておく — 行さえ溜まれば
//     後で Workers 経路 / 管理 API / Cron などから配信を回せる。
//   - SUPABASE_SERVICE_ROLE_KEY が未設定だと createAdminClient で起動失敗するため、
//     最小テスト経路（healthDbProbe を渡さない）でも実呼び出ししない限り問題ない。
const buildWebhookSidecars = (
  env: Env,
  logger: AppLogger,
  webhookFetcher?: typeof fetch,
): { publisher: EventPublisher; dispatchMiddleware: MiddlewareHandler<AppEnv> } => {
  const adminSb = createAdminClient(env);
  const subscriptionRepo = new SupabaseWebhookSubscriptionRepository(adminSb);
  const deliveryRepo = new SupabaseWebhookDeliveryRepository(adminSb);
  const publisher = createWebhookEventPublisher({
    subscriptionRepo,
    deliveryRepo,
    logger,
  });
  if (!webhookFetcher) {
    return { publisher, dispatchMiddleware: noopWebhookDispatchMiddleware };
  }
  const dispatcher = createFetchWebhookDispatcher({ fetcher: webhookFetcher });
  const dispatchMiddleware = createWebhookDispatchMiddleware({
    deliveryRepo,
    dispatcher,
  });
  return { publisher, dispatchMiddleware };
};

export const bootstrap = (deps: BootstrapDeps): OpenAPIHono<AppEnv> => {
  const {
    env,
    logger,
    jwksFetcherProvider,
    appVersion,
    metricsRecorder,
    rateLimiters,
    idempotencyStore,
    webhookFetcher,
  } = deps;

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
  const idempotencyMiddlewares = buildIdempotencyMiddlewares(idempotencyStore);
  // Phase 10 Step 7: Webhook 副系（publisher + dispatch middleware）を 1 度だけ組み立てる。
  //   publisher は ModuleDeps 経由で composition-root → PlaceOrderUseCase に注入される。
  //   dispatchMiddleware は /v1/* グローバル middleware として全 v1 リクエスト後に
  //   1 ラウンドの delivery 配信を回す（Workers のみ、Node では noop）。
  const { publisher, dispatchMiddleware: webhookDispatchMiddleware } = buildWebhookSidecars(
    env,
    logger,
    webhookFetcher,
  );

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
      createModulesMiddleware({ env, logger, publisher }),
    ],
    guards: {
      adminGuard: [requireAuth(), requireAdmin()],
      authGuard: [requireAuth()],
    },
    rateLimitMiddlewares,
    idempotencyMiddlewares,
    webhookDispatchMiddleware,
    logger,
    appVersion,
    healthDbProbe: createHealthDbProbe(env),
  });
};
