import { z } from '@hono/zod-openapi';

// `@hono/zod-openapi` の z は zod を再エクスポートしたもの。
// `.openapi()` メソッドで OpenAPI 仕様（example / description / コンポーネント名）を
// スキーマに直接埋め込める。これにより Zod スキーマ 1 か所だけ管理すれば
// 入力バリデーションと OpenAPI ドキュメントが両方揃う（二重管理ゼロ）。

// ---------------------------------------------------------------------------
// Response: API 上のケーキ表現（1 件）
//   domain の Cake / Price / CakeId そのものは外に晒さない。
//   ここで「外向きの形」を定義することで、内部の VO を変えても API は壊れない。
// ---------------------------------------------------------------------------
export const CakeResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '11111111-1111-4111-8111-111111111111' }),
    name: z.string().openapi({ example: 'ショートケーキ' }),
    price: z.number().int().openapi({ example: 480 }),
    stock: z.number().int().openapi({ example: 20 }),
  })
  .openapi('Cake');

export type CakeResponse = z.infer<typeof CakeResponseSchema>;

// ---------------------------------------------------------------------------
// Response: GET /v1/cakes
//   配列直返しではなくオブジェクトに包むのは、将来 pagination / total を
//   ルートに追加しても破壊的変更にならないようにするため（API 設計の定石）。
// ---------------------------------------------------------------------------
export const ListCakesResponseSchema = z
  .object({
    cakes: z.array(CakeResponseSchema),
  })
  .openapi('ListCakesResponse');

// ---------------------------------------------------------------------------
// Request: POST /v1/cakes
//   制約は domain（Cake.create / Price.of）と一致させる。
//   ここで弾けば壊れた入力が UseCase まで届かないので、ハッピーパスが綺麗になる。
//   ただし domain も同じ検証を持つことで、HTTP 層をバイパスした経路（CLI / job）でも
//   不変条件は守られる（多重防御）。
// ---------------------------------------------------------------------------
export const CreateCakeRequestSchema = z
  .object({
    name: z
      .string()
      .min(1, { message: 'ケーキ名は必須です' })
      .max(100, { message: 'ケーキ名は 100 文字以内です' })
      .openapi({ example: 'モンブラン' }),
    price: z
      .number()
      .int({ message: '価格は整数である必要があります' })
      .min(1, { message: '価格は 1 以上である必要があります' })
      .max(1_000_000, { message: '価格は 1,000,000 以下である必要があります' })
      .openapi({ example: 600 }),
    stock: z
      .number()
      .int({ message: '在庫数は整数である必要があります' })
      .min(0, { message: '在庫数は 0 以上である必要があります' })
      .openapi({ example: 10 }),
  })
  .openapi('CreateCakeRequest');

export type CreateCakeRequest = z.infer<typeof CreateCakeRequestSchema>;

// ---------------------------------------------------------------------------
// 共通: エラーレスポンス（CLAUDE.md の統一形式に対応）
//   400 / 409 など複数のステータスで共通利用する。
//   error-handler が AppError から自動でこの形に整形する。
// ---------------------------------------------------------------------------
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'リクエストパラメータが不正です' }),
      details: z
        .array(
          z.object({
            field: z.string(),
            message: z.string(),
          }),
        )
        .optional(),
    }),
  })
  .openapi('ErrorResponse');
