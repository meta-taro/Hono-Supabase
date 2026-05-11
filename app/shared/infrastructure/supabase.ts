import { createClient } from '@supabase/supabase-js';
import type { Env } from '@/shared/http/env';

// 型付き Database スキーマを生成していないため、createClient の戻り値は
// SupabaseClient<any, ...> 相当になる。明示注釈を付けると inferred な generics と
// ズレて no-unsafe-return になるので、createClient の戻り型をそのまま使う。
type ServerSupabaseClient = ReturnType<typeof createClient>;

// サーバーサイド向け共通オプション。
// セッションをサーバー側に永続化しないことで、
// 複数リクエスト間でユーザー状態が混在する事故を構造的に防ぐ。
const SERVER_AUTH_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
} as const;

// anon キー版: RLS が効く一般ユーザー権限のクライアント。
// 認証済みユーザーの操作は、ここで作ったクライアントに JWT を載せて使う想定。
export const createAnonClient = (env: Env): ServerSupabaseClient =>
  createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, SERVER_AUTH_OPTIONS);

// service_role キー版: RLS をバイパスする管理者権限のクライアント。
// バックエンドジョブ・管理エンドポイント等、限られた経路でのみ使う。
// 一般ユーザーリクエストの処理経路には絶対に渡さないこと（権限混在は事故の温床）。
export const createAdminClient = (env: Env): ServerSupabaseClient =>
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, SERVER_AUTH_OPTIONS);
