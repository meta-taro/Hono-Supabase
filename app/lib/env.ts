import { z } from 'zod';

// 起動時に env を Zod で検証することで、PORT=abc のような不正値や
// 未設定変数を「サーバー起動時点」で fail-fast にできる。
// Phase 3 で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY を
// この schema に追加する想定。
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3010),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

// テスト用に raw env を差し替えられるよう関数化している。
export const loadEnv = (raw: NodeJS.ProcessEnv = process.env): Env => envSchema.parse(raw);

export const env = loadEnv();
