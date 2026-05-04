import { serve } from '@hono/node-server';
import { createApp } from '@/app';
import { env } from '@/shared/http/env';
import { logger } from '@/shared/infrastructure/logger';
import { buildAppModules } from '@/shared/composition-root';

// 本番経路で唯一の DI 起点。
// composition-root で Bounded Context を組み立て、createApp に注入する。
const modules = buildAppModules({ env, logger });
const app = createApp(modules);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, `Server running at http://localhost:${info.port}`);
});
