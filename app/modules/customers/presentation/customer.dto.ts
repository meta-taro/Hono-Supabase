import { z } from '@hono/zod-openapi';

// `@hono/zod-openapi` の z は zod を再エクスポートしたもの。
// `.openapi()` メソッドで OpenAPI 仕様（example / description / コンポーネント名）を
// スキーマに直接埋め込める。これにより Zod スキーマ 1 か所だけ管理すれば
// 入力バリデーションと OpenAPI ドキュメントが両方揃う（二重管理ゼロ）。

// ---------------------------------------------------------------------------
// Response: API 上の顧客表現（1 件）
//   domain の Customer / CustomerId / Email そのものは外に晒さない。
//   ここで「外向きの形」を定義することで、内部の VO を変えても API は壊れない。
// ---------------------------------------------------------------------------
export const CustomerResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '22222222-2222-4222-8222-222222222222' }),
    name: z.string().openapi({ example: '田中太郎' }),
    email: z.string().email().openapi({ example: 'tanaka@example.com' }),
  })
  .openapi('Customer');

export type CustomerResponse = z.infer<typeof CustomerResponseSchema>;

// ---------------------------------------------------------------------------
// Response: GET /v1/customers
//   配列直返しではなくオブジェクトに包むのは、将来 pagination / total を
//   ルートに追加しても破壊的変更にならないようにするため（API 設計の定石）。
// ---------------------------------------------------------------------------
export const ListCustomersResponseSchema = z
  .object({
    customers: z.array(CustomerResponseSchema),
  })
  .openapi('ListCustomersResponse');

// ---------------------------------------------------------------------------
// Request: POST /v1/customers
//   制約は domain（Customer.create / Email.of）と一致させる。
//   ここで弾けば壊れた入力が UseCase まで届かないので、ハッピーパスが綺麗になる。
//   ただし domain も同じ検証を持つことで、HTTP 層をバイパスした経路（CLI / job）でも
//   不変条件は守られる（多重防御）。
// ---------------------------------------------------------------------------
// Phase 6 でサインアップ仕様に変更:
//   - password を追加（Supabase Auth に渡す）
//   - email/name の制約は domain 層と一致
//   - パスワード長は Supabase Auth のデフォルト最小値（6 文字）に揃える
export const SignUpCustomerRequestSchema = z
  .object({
    name: z
      .string()
      .min(1, { message: '顧客名は必須です' })
      .max(100, { message: '顧客名は 100 文字以内です' })
      .openapi({ example: '田中太郎' }),
    email: z
      .string()
      .email({ message: 'メールアドレスの形式が不正です' })
      .max(254, { message: 'メールアドレスは 254 文字以内です' })
      .openapi({ example: 'tanaka@example.com' }),
    password: z
      .string()
      .min(6, { message: 'パスワードは 6 文字以上である必要があります' })
      .max(72, { message: 'パスワードは 72 文字以内である必要があります' })
      .openapi({ example: 'secret-password' }),
  })
  .openapi('SignUpCustomerRequest');

export type SignUpCustomerRequest = z.infer<typeof SignUpCustomerRequestSchema>;

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
