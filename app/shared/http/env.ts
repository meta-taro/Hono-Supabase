import { z } from 'zod';

// 起動時に env を Zod で検証することで、不正値や未設定変数を
// 「サーバー起動時点」で fail-fast にできる。
// Supabase 系を required にするのは、3 つすべて揃わないと
// アプリが本質的に機能しないため（部分起動を許すと事故の温床）。
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3010),
  // staging は Cloudflare Workers の [env.staging] で使う値。
  // 「本番に限りなく近い設定で動かす」前段環境という位置づけで、ランタイムの挙動
  // （pino-pretty の有無等）は production と同じ扱いにする（node-pino-logger.ts 参照）。
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Supabase 接続情報（ローカル: supabase status の出力を .env に転記）
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

// raw env を差し替えられるよう関数化している。
//   - Node では `process.env` を、Cloudflare Workers では `c.env`（バインディング）を渡せる。
//   - 型は両者を満たす最小公約数の `Record<string, string | undefined>` に緩める。
//     `process.env`（NodeJS.ProcessEnv）も Workers の env オブジェクトも、これに代入互換。
export type RawEnv = Record<string, string | undefined>;

// 注意: ここで `export const env = loadEnv()` のような即時実行はしない。
// Cloudflare Workers の bundle に乗せるとモジュール評価時に process.env を読み、
// `process is not defined` でクラッシュする。ランタイムごとのエントリ
// （index.node.ts / index.workers.ts）で明示的に loadEnv() を呼ぶ。
export const loadEnv = (raw: RawEnv = process.env): Env => envSchema.parse(raw);
