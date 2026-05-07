import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Response: API 上の注文表現（1 件）
//   domain の Order / OrderItem / 各種 VO は外に晒さない。
//   ここで「外向きの形」を固定することで、内部 VO を変えても API は壊れない。
// ---------------------------------------------------------------------------
export const OrderItemResponseSchema = z
  .object({
    cakeId: z
      .string()
      .uuid()
      .openapi({ example: '11111111-1111-4111-8111-111111111111' }),
    quantity: z.number().int().openapi({ example: 2 }),
    unitPrice: z.number().int().openapi({ example: 600 }),
    subtotal: z.number().int().openapi({ example: 1200 }),
  })
  .openapi('OrderItem');

export type OrderItemResponse = z.infer<typeof OrderItemResponseSchema>;

export const OrderResponseSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .openapi({ example: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    customerId: z
      .string()
      .uuid()
      .openapi({ example: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    status: z.enum(['PLACED', 'CANCELED']).openapi({ example: 'PLACED' }),
    totalAmount: z.number().int().openapi({ example: 1200 }),
    placedAt: z
      .string()
      .datetime()
      .openapi({ example: '2026-05-06T10:00:00.000Z' }),
    items: z.array(OrderItemResponseSchema),
  })
  .openapi('Order');

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

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
      details: z
        .array(z.object({ field: z.string(), message: z.string() }))
        .optional(),
    }),
  })
  .openapi('ErrorResponse');
