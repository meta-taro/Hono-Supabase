import { z } from 'zod';

// 起動時に env を Zod で検証することで、不正値や未設定変数を
// 「サーバー起動時点」で fail-fast にできる。
// Supabase 系を required にするのは、3 つすべて揃わないと
// アプリが本質的に機能しないため（部分起動を許すと事故の温床）。
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3010),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Supabase 接続情報（ローカル: supabase status の出力を .env に転記）
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

// テスト用に raw env を差し替えられるよう関数化している。
export const loadEnv = (raw: NodeJS.ProcessEnv = process.env): Env => envSchema.parse(raw);

export const env = loadEnv();
