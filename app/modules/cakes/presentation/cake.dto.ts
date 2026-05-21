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

// ページネーションの既定値・上限。
//   DEFAULT_LIMIT: クライアントが limit 未指定のときの 1 ページ件数。
//   MAX_LIMIT: 1 リクエストで取得できる最大件数（無制限取得 = 重い全件スキャンを防ぐ）。
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// 価格フィルタの上限（CreateCakeRequestSchema の price 上限と揃える）。
const PRICE_MAX = 1_000_000;

// ---------------------------------------------------------------------------
// Request: GET /v1/cakes のクエリパラメータ
//   limit     … 1 ページ件数（1〜MAX_LIMIT、未指定なら DEFAULT_LIMIT）。
//   after     … 前ページのレスポンスが返した next_cursor（不透明トークン）。
//   sort      … 並び順。'-' 接頭辞で降順、カンマ区切りで複数指定（例 '-price,name'）。
//               許可フィールドの検証は controller の parseSortParam が担う（400 を投げる）。
//   available … 在庫の有無で絞る（'true'=在庫あり / 'false'=在庫切れ）。
//   min_price / max_price … 価格帯で絞る（両端含む）。
//   q         … ケーキ名の部分一致検索。
//   クエリ文字列は常に string で届くため、数値・真偽は coerce / enum で変換する。
// ---------------------------------------------------------------------------
export const ListCakesQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int({ message: 'limit は整数である必要があります' })
    .min(1, { message: 'limit は 1 以上である必要があります' })
    .max(MAX_LIMIT, { message: `limit は ${String(MAX_LIMIT)} 以下である必要があります` })
    .default(DEFAULT_LIMIT)
    .openapi({ example: 20, description: '1 ページの件数（1〜100、既定 20）' }),
  after: z
    .string()
    .optional()
    .openapi({ description: '前ページの next_cursor。先頭ページでは省略する。' }),
  sort: z.string().optional().openapi({
    example: '-price,name',
    description:
      "並び順。'-' で降順、カンマ区切りで複数指定。許可: name, price, stock（既定: name 昇順）",
  }),
  available: z.enum(['true', 'false']).optional().openapi({
    example: 'true',
    description: '在庫の有無で絞る（true=在庫あり / false=在庫切れ）',
  }),
  min_price: z.coerce
    .number()
    .int({ message: 'min_price は整数である必要があります' })
    .min(1, { message: 'min_price は 1 以上である必要があります' })
    .max(PRICE_MAX, { message: `min_price は ${String(PRICE_MAX)} 以下である必要があります` })
    .optional()
    .openapi({ example: 300, description: '価格の下限（この値を含む）' }),
  max_price: z.coerce
    .number()
    .int({ message: 'max_price は整数である必要があります' })
    .min(1, { message: 'max_price は 1 以上である必要があります' })
    .max(PRICE_MAX, { message: `max_price は ${String(PRICE_MAX)} 以下である必要があります` })
    .optional()
    .openapi({ example: 1000, description: '価格の上限（この値を含む）' }),
  q: z
    .string()
    .min(1, { message: 'q は 1 文字以上である必要があります' })
    .max(100, { message: 'q は 100 文字以内である必要があります' })
    .optional()
    .openapi({ example: 'いちご', description: 'ケーキ名の部分一致検索（大文字小文字を無視）' }),
});

export type ListCakesQuery = z.infer<typeof ListCakesQuerySchema>;

// カーソルの中身（不透明トークンをデコードした後の形）。
// controller が decodeCursor() で検証に使う。改竄されていれば 400 に倒す。
//   sort   … カーソル発行時の並び順（正規形文字列）。次ページ要求の sort と一致必須。
//   values … sort 各フィールドの最終行の値。フィールドにより string / number。
//   id     … tiebreaker。
export const CakeCursorSchema = z.object({
  sort: z.string(),
  values: z.object({
    name: z.string().optional(),
    price: z.number().int().optional(),
    stock: z.number().int().optional(),
  }),
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Response: GET /v1/cakes
//   配列直返しではなくオブジェクトに包むことで、ページネーションのメタ情報を
//   同居させても破壊的変更にならない（API 設計の定石）。
//   next_cursor: 次ページがある場合の不透明トークン。無ければ null。
//   has_more:    次ページの有無（next_cursor !== null と同義の利便フラグ）。
// ---------------------------------------------------------------------------
export const ListCakesResponseSchema = z
  .object({
    cakes: z.array(CakeResponseSchema),
    next_cursor: z.string().nullable().openapi({
      example: 'eyJuYW1lIjoi...',
      description: '次ページ取得用カーソル（無ければ null）',
    }),
    has_more: z.boolean().openapi({ example: true, description: '次ページが存在するか' }),
  })
  .openapi('ListCakesResponse');

export type ListCakesResponse = z.infer<typeof ListCakesResponseSchema>;

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
