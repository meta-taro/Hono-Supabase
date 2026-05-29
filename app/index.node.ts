import { serve } from '@hono/node-server';
import { bootstrap } from '@/bootstrap';
import { loadEnv } from '@/shared/http/env';
import { createNodePinoLogger } from '@/shared/infrastructure/node-pino-logger';
import { createNodeJwksFetcher } from '@/shared/infrastructure/jwks-fetcher';
import { createAdminClient } from '@/shared/infrastructure/supabase';
import { SupabaseIdempotencyStore } from '@/shared/infrastructure/supabase-idempotency-store';

// ---------------------------------------------------------------------------
// Node エントリ（ローカル開発・TDD・デバッグ用）。
//
// 本番（Cloudflare Workers）は app/index.workers.ts が担当する。
// この 2 系統で「組み立て方」だけが違い、Hono アプリ本体（app/bootstrap.ts）は共通。
//
// 起動コマンド:
//   pnpm dev    → tsx watch --env-file=.env app/index.node.ts
//   pnpm start  → node --env-file=.env dist/index.node.js
// ---------------------------------------------------------------------------

// env / logger は process.env を読む factory なので、エントリで 1 回だけ生成する。
// この設計により env.ts / logger.ts のモジュール評価で process.env を触らずに済み、
// Workers bundle でも safe（index.workers.ts は bindings 経由で同じことをする）。
const env = loadEnv();
const logger = createNodePinoLogger();

// Node では fetcher は ctx に依存しない。Provider は単に同じインスタンスを返すだけ。
// jose のメモリキャッシュにそのまま乗るので Cache API は不要。
const nodeFetcher = createNodeJwksFetcher();
// Phase 10 Step 6: Idempotency 永続化は service_role 必須（RLS バイパス）。
// Node 起点でも本番と同じ Supabase 経由のストアで動作確認できるよう、ここで組み立てる。
// `.env` の SUPABASE_* が無効なら起動時に Zod 検証で弾かれるため、ここではエラーを握らない。
const idempotencyStore = new SupabaseIdempotencyStore(createAdminClient(env));

const app = bootstrap({
  env,
  logger,
  jwksFetcherProvider: () => nodeFetcher,
  // Node ローカルにはデプロイ済みバージョンの概念がないので固定値。
  // 本番（Workers）は version_metadata 由来のバージョン ID が入る。
  appVersion: 'local',
  idempotencyStore,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, `Server running at http://localhost:${String(info.port)}`);
});
