import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { createOpenAPIHono } from '@/shared/http/openapi-hono';
import {
  CakeResponseSchema,
  CreateCakeRequestSchema,
  ErrorResponseSchema,
  ListCakesResponseSchema,
} from './cake.dto';
import type { CakeController } from './cake.controller';

// ---------------------------------------------------------------------------
// Route 定義
//   `createRoute()` は Hono に「OpenAPI 仕様付きの型安全なルート」を登録するための関数。
//   Zod スキーマをここに紐付けることで、
//     - ハンドラ内で c.req.valid('json') が型推論される
//     - /openapi.json 自動生成（Phase 6 で公開）
//     - リクエスト Zod 検証失敗時に自動で 400 + 統一エラーレスポンス
//   が同時に得られる。
//
//   path は '/' にする — このルーターは app.ts 側で `app.route('/v1/cakes', ...)` で
//   マウントされるため、ここでは相対パスを使う（重複定義防止）。
// ---------------------------------------------------------------------------

const listCakesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['cakes'],
  summary: 'ケーキ一覧を取得する',
  description:
    'すべてのケーキを名前昇順で返す。認証不要（Phase 6 で確認）。',
  responses: {
    200: {
      description: 'ケーキ一覧',
      content: { 'application/json': { schema: ListCakesResponseSchema } },
    },
  },
});

const createCakeRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['cakes'],
  summary: 'ケーキを登録する',
  description:
    '新しいケーキをカタログに追加する。Phase 6 で管理者ロール必須に変更予定。',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateCakeRequestSchema } },
    },
  },
  responses: {
    201: {
      description: '作成されたケーキ',
      content: { 'application/json': { schema: CakeResponseSchema } },
    },
    400: {
      description: 'リクエストパラメータが不正',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'ID が重複している',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router ファクトリ
//   Controller を引数にもらうことで、本番でも統合テストでも同じ構造で組める。
//   - 本番:    composition-root が実 UseCase を渡す
//   - テスト:  モック UseCase で組んだ Controller を渡す（HTTP 層だけ検証）
// ---------------------------------------------------------------------------
export const createCakeRouter = (controller: CakeController): OpenAPIHono => {
  // createOpenAPIHono を使うことで、Zod 検証失敗が自動的に ValidationError → 400 統一形式に変換される
  const router = createOpenAPIHono();

  router.openapi(listCakesRoute, async (c) => {
    const body = await controller.list();
    return c.json(body, 200);
  });

  router.openapi(createCakeRoute, async (c) => {
    // c.req.valid('json') は Zod 検証通過後の型付き値を返す（CreateCakeRequest 型）
    const input = c.req.valid('json');
    const body = await controller.create(input);
    return c.json(body, 201);
  });

  return router;
};
