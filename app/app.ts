import { OpenAPIHono } from '@hono/zod-openapi';
import { errorHandler } from '@/shared/http/error-handler';

// app と index.ts を分離することで、テストが serve を起動せずに
// app.request() で直接 fetch ハンドラを叩けるようにしている。
export const createApp = (): OpenAPIHono => {
  const app = new OpenAPIHono();

  // /health は非バージョン・認証不要（CLAUDE.md API 設計）。
  // OpenAPI ドキュメント生成は Phase 5 で zod-openapi 化する。
  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.onError(errorHandler);

  return app;
};
