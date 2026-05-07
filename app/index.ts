import { serve } from '@hono/node-server';
import { createApp } from '@/app';
import { env } from '@/shared/http/env';
import { logger } from '@/shared/infrastructure/logger';
import { createModulesMiddleware } from '@/shared/composition-root';
import {
  createOptionalAuthMiddleware,
  createRequestSupabaseMiddleware,
  requireAuth,
  requireAdmin,
} from '@/shared/http/auth.middleware';

// 本番経路で唯一の DI 起点。
// Phase 6 では sb をリクエストごとに作り、modules も per-request に組み立てる。
//
// /v1/* に通すミドルウェア順序（重要）:
//   1. optionalAuth: Authorization ヘッダがあれば JWT を検証 → c.var.user / c.var.jwt
//   2. requestSupabase: c.var.jwt を載せた anon クライアントを c.var.sb に
//   3. modulesMiddleware: sb から Bounded Context 別 controller を組んで c.var.modules に
//
// ルート単位のガード:
//   adminGuard = [requireAuth, requireAdmin]
//   authGuard  = [requireAuth]
const moduleDeps = { env, logger };
const app = createApp({
  rootMiddlewares: [
    createOptionalAuthMiddleware(env),
    createRequestSupabaseMiddleware(env),
    createModulesMiddleware(moduleDeps),
  ],
  guards: {
    adminGuard: [requireAuth(), requireAdmin()],
    authGuard: [requireAuth()],
  },
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, `Server running at http://localhost:${info.port}`);
});
