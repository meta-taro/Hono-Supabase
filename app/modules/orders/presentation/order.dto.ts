import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Response: API 上の注文表現（1 件）
//   domain の Order / OrderItem / 各種 VO は外に晒さない。
//   ここで「外向きの形」を固定することで、内部 VO を変えても API は壊れない。
// ---------------------------------------------------------------------------
export const OrderItemResponseSchema = z
  .object({
    cakeId: z.string().uuid().openapi({ example: '11111111-1111-4111-8111-111111111111' }),
    quantity: z.number().int().openapi({ example: 2 }),
    unitPrice: z.number().int().openapi({ example: 600 }),
    subtotal: z.number().int().openapi({ example: 1200 }),
  })
  .openapi('OrderItem');

export type OrderItemResponse = z.infer<typeof OrderItemResponseSchema>;

export const OrderResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    customerId: z.string().uuid().openapi({ example: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    status: z.enum(['PLACED', 'CANCELED']).openapi({ example: 'PLACED' }),
    totalAmount: z.number().int().openapi({ example: 1200 }),
    placedAt: z.string().datetime().openapi({ example: '2026-05-06T10:00:00.000Z' }),
    items: z.array(OrderItemResponseSchema),
  })
  .openapi('Order');

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

// ページネーションの既定値・上限（cakes 一覧と揃える）。
//   DEFAULT_LIMIT: limit 未指定時の 1 ページ件数。
//   MAX_LIMIT: 1 リクエストの最大件数（無制限取得 = 重い全件スキャンを防ぐ）。
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Request: GET /v1/orders のクエリパラメータ
//   limit … 1 ページ件数（1〜MAX_LIMIT、未指定なら DEFAULT_LIMIT）。
//           クエリ文字列は常に string で届くため coerce で数値化する。
//   after … 前ページのレスポンスが返した next_cursor（不透明トークン）をそのまま渡す。
// ---------------------------------------------------------------------------
export const ListOrdersQuerySchema = z.object({
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
});

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

// カーソルの中身（不透明トークンをデコードした後の形）。
// controller が decodeCursor() で検証に使う。改竄されていれば 400 に倒す。
//   placedAt … ISO 8601 UTC 文字列（DB の placed_at と同表現で辞書順 = 時系列順）。
//   id       … 同時刻の tiebreaker（注文 ID）。
export const OrderCursorSchema = z.object({
  placedAt: z.string().datetime(),
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Response: GET /v1/orders
//   配列直返しではなくオブジェクトに包み、ページネーションのメタ情報を同居させる。
//   next_cursor: 次ページがある場合の不透明トークン。無ければ null。
//   has_more:    次ページの有無（next_cursor !== null と同義の利便フラグ）。
// ---------------------------------------------------------------------------
export const ListOrdersResponseSchema = z
  .object({
    orders: z.array(OrderResponseSchema),
    next_cursor: z.string().nullable().openapi({
      example: 'eyJwbGFjZWRBdCI6...',
      description: '次ページ取得用カーソル（無ければ null）',
    }),
    has_more: z.boolean().openapi({ example: true, description: '次ページが存在するか' }),
  })
  .openapi('ListOrdersResponse');

export type ListOrdersResponse = z.infer<typeof ListOrdersResponseSchema>;

// ---------------------------------------------------------------------------
// Request: POST /v1/orders
//   制約は domain（OrderQuantity / Order.assertItemsShape）と一致させる。
//   ここで弾けば壊れた入力が UseCase まで届かないので、ハッピーパスが綺麗になる。
//   ただし domain も同じ検証を持つことで、HTTP 層をバイパスした経路でも不変条件は守られる。
//
//   Phase 6 で customerId は body から外した:
//     - サーバー側で JWT subject (auth.users.id) → customer 行を解決する
//     - body で customerId を受け取ると「他人の名義で注文できる」改竄が成立してしまう
// ---------------------------------------------------------------------------
export const CreateOrderItemRequestSchema = z.object({
  cakeId: z.string().uuid({ message: 'cakeId は UUID である必要があります' }),
  quantity: z
    .number()
    .int({ message: '数量は整数である必要があります' })
    .min(1, { message: '数量は 1 以上である必要があります' })
    .max(100, { message: '数量は 100 以下である必要があります' }),
});

export const CreateOrderRequestSchema = z
  .object({
    items: z
      .array(CreateOrderItemRequestSchema)
      .min(1, { message: '注文には商品が 1 つ以上必要です' })
      .max(50, { message: '1 注文の明細数は 50 件以下である必要があります' }),
  })
  .openapi('CreateOrderRequest');

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

// ---------------------------------------------------------------------------
// Path param: GET /v1/orders/:id
// ---------------------------------------------------------------------------
export const OrderIdParamSchema = z.object({
  id: z
    .string()
    .uuid({ message: 'id は UUID である必要があります' })
    .openapi({
      param: { name: 'id', in: 'path' },
      example: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }),
});

// ---------------------------------------------------------------------------
// 共通: エラーレスポンス（CLAUDE.md の統一形式）
// ---------------------------------------------------------------------------
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'リクエストパラメータが不正です' }),
      details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    }),
  })
  .openapi('ErrorResponse');
