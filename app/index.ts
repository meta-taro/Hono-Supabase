import { serve } from '@hono/node-server';
import { createApp } from '@/app';
import { env } from '@/shared/http/env';
import { logger } from '@/shared/infrastructure/logger';

const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, `Server running at http://localhost:${info.port}`);
});
