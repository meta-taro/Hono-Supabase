/// <reference types="@cloudflare/workers-types" />

import { bootstrap } from '@/bootstrap';
import { loadEnv } from '@/shared/http/env';
import { createWorkersLogger } from '@/shared/infrastructure/logger';
import {
  createNodeJwksFetcher,
  createWorkersJwksFetcher,
  type JwksFetcherProvider,
} from '@/shared/infrastructure/jwks-fetcher';

// ---------------------------------------------------------------------------
// Cloudflare Workers エントリ（本番デプロイ先）。
//
// なぜ ExportedHandler 形式なのか:
//   wrangler dev / wrangler deploy が期待する Workers 標準のエクスポート形式。
//   `export default { fetch }` でリクエスト 1 件分を処理する。
//
// 第 2 引数 bindings:
//   wrangler が `[vars]` / `wrangler secret put` から注入する環境変数。
//   process.env は Workers では使えないため、ここで受け取って Zod 検証に通す。
//
// 第 3 引数 ctx:
//   `ctx.waitUntil(promise)` でレスポンス返却後にバックグラウンド処理を継続。
//   Hono 側へ `app.fetch(request, env, ctx)` 形で渡せば middleware から
//   `c.executionCtx` で取り出せるので、JwksFetcherProvider はそこを通じて
//   per-request に Cache API ベースの fetcher を生成する。
//
// アプリ組み立ては cold start 時に 1 回だけ:
//   Workers は isolate ごとに module top-level を 1 回評価する。bootstrap 結果を
//   モジュールスコープにキャッシュすれば毎リクエスト組み立て直す必要はない。
//   secrets / vars は bindings 経由なので isolate 生存中は不変。
// ---------------------------------------------------------------------------

interface WorkersBindings {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  LOG_LEVEL?: string;
  NODE_ENV?: string;
  // wrangler.toml の [version_metadata] バインディング（Cloudflare が自動で埋める）。
  // この isolate が動かしているデプロイ済みバージョンの ID / tag / アップロード時刻。
  // ローカル wrangler dev では placeholder 値、未宣言環境では undefined になりうるので
  // 参照側は ?. + フォールバックで扱う。
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

type Handler = (request: Request, ctx: ExecutionContext) => Promise<Response>;

let cachedHandler: Handler | null = null;

const buildHandler = (bindings: WorkersBindings): Handler => {
  // CF_VERSION_METADATA はオブジェクト型のバインディングなので、文字列だけを期待する
  // loadEnv（RawEnv = string の Record）には渡さない。残りのキーだけスプレッドする。
  const { CF_VERSION_METADATA, ...envBindings } = bindings;
  // WorkersBindings は固定キーの interface のため RawEnv（任意キー Record）に
  // 直接キャストできない。スプレッドで「普通の Record」を作って渡す。
  const env = loadEnv({ ...envBindings });
  const logger = createWorkersLogger({
    // env.LOG_LEVEL は Zod で 'debug' | 'info' | 'warn' | 'error' に絞られている。
    level: env.LOG_LEVEL,
  });

  // per-request に呼ばれる provider。
  //   ctx あり → Cache API + ctx.waitUntil で SWR
  //   ctx なし → 起動時の jose 内部生成パスなど。Node fetcher にフォールバック。
  const jwksFetcherProvider: JwksFetcherProvider = (ctx) => {
    if (!ctx) return createNodeJwksFetcher();
    return createWorkersJwksFetcher({
      cache: caches.default,
      ctx,
      fetch: globalThis.fetch.bind(globalThis),
    });
  };

  // version_metadata はこの isolate のデプロイ済みバージョンに固定なので cold start 時に
  // 1 回読めば十分。/health に晒して段階展開（カナリア）中の応答元バージョンを観察可能にする。
  const appVersion = CF_VERSION_METADATA?.id ?? 'unknown';

  const app = bootstrap({ env, logger, jwksFetcherProvider, appVersion });
  return async (request, ctx) => app.fetch(request, bindings, ctx);
};

export default {
  async fetch(
    request: Request,
    bindings: WorkersBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const handler = cachedHandler ?? buildHandler(bindings);
    cachedHandler = handler;
    return handler(request, ctx);
  },
} satisfies ExportedHandler<WorkersBindings>;
