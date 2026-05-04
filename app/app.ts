import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorHandler } from '@/shared/http/error-handler';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import type { AppModules } from '@/shared/composition-root';

// app と index.ts を分離することで、テストが serve を起動せずに
// app.request() で直接 fetch ハンドラを叩けるようにしている。
//
// modules を optional にしている理由:
//   - 引数なし（既存の health.test.ts 互換）: /health のみを持つ最小 app
//   - modules 指定（本番 / cakes 統合テスト）: /v1 配下に Bounded Context 別 router をマウント
// このシンプルな分岐で、テストはモック注入・本番は実 DI と使い分けられる。
export const createApp = (modules?: AppModules): OpenAPIHono => {
  // createOpenAPIHono は defaultHook 付きで Zod 検証失敗を統一エラー形式に整える。
  const app = createOpenAPIHono();

  // /health は非バージョン・認証不要（CLAUDE.md API 設計）。
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // /v1 配下の Bounded Context をマウントする。
  // Hono の app.route() は OpenAPI 定義込みでサブルーターを取り込んでくれる。
  if (modules) {
    app.route('/v1/cakes', modules.cakesRouter);
  }

  app.onError(errorHandler);

  return app;
};
