import { z } from '@hono/zod-openapi';
import { REVIEW_SORT_OPTIONS } from '@/modules/reviews/domain/review.repository';

// ---------------------------------------------------------------------------
// パスパラメータ: /v1/cakes/{cake_id}/reviews
// ---------------------------------------------------------------------------
export const CakeIdPathParamSchema = z.object({
  cake_id: z
    .string()
    .uuid({ message: 'cake_id は UUID 形式である必要があります' })
    .openapi({
      param: { name: 'cake_id', in: 'path' },
      example: '11111111-1111-4111-8111-111111111111',
    }),
});

export type CakeIdPathParam = z.infer<typeof CakeIdPathParamSchema>;

// ---------------------------------------------------------------------------
// Response: レビュー 1 件
// ---------------------------------------------------------------------------
export const ReviewResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '22222222-2222-4222-8222-222222222222' }),
    cake_id: z.string().uuid().openapi({ example: '11111111-1111-4111-8111-111111111111' }),
    // 投稿者は表示用の文字列 ID のみ。ユーザー名や email は外に晒さない。
    user_id: z.string().openapi({ example: 'auth-user-abcdef' }),
    rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
    title: z.string().openapi({ example: 'とても美味しかった' }),
    body: z.string().openapi({ example: '生クリームの甘さが絶妙でした。' }),
    is_verified_purchaser: z.boolean().openapi({
      example: true,
      description: '投稿時点で当該 cake を購入済みだったか（snapshot）',
    }),
    helpful_count: z.number().int().min(0).openapi({ example: 12 }),
    created_at: z.string().datetime().openapi({ example: '2026-05-27T10:00:00.000Z' }),
  })
  .openapi('Review');

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

// 集計（一覧 API のレスポンスに添える）。
export const ReviewStatsResponseSchema = z
  .object({
    count: z.number().int().min(0).openapi({ example: 123 }),
    // 0 件のときは null（クライアントが「まだ評価なし」を表現できるように）
    average: z.number().min(1).max(5).nullable().openapi({ example: 4.5 }),
    distribution: z
      .object({
        '1': z.number().int().min(0).openapi({ example: 3 }),
        '2': z.number().int().min(0).openapi({ example: 5 }),
        '3': z.number().int().min(0).openapi({ example: 20 }),
        '4': z.number().int().min(0).openapi({ example: 40 }),
        '5': z.number().int().min(0).openapi({ example: 55 }),
      })
      .openapi({ description: '星別件数（key は 1..5、0 件の星も 0 を返す）' }),
  })
  .openapi('ReviewStats');

export type ReviewStatsResponse = z.infer<typeof ReviewStatsResponseSchema>;

// ---------------------------------------------------------------------------
// ページネーション既定値・上限
// ---------------------------------------------------------------------------
export const DEFAULT_REVIEW_LIMIT = 20;
export const MAX_REVIEW_LIMIT = 100;

// ---------------------------------------------------------------------------
// Request: GET /v1/cakes/{cake_id}/reviews のクエリ
//   sort           … 並び順（newest | helpful。既定 newest）
//   limit          … 1 ページ件数（1〜100、既定 20）
//   filter_rating  … 星別フィルタ（1〜5）
//   verified_only  … 購入済みバッジ付きのみ
//   after          … 前ページ next_cursor
// ---------------------------------------------------------------------------
export const ListReviewsQuerySchema = z.object({
  sort: z
    .enum(REVIEW_SORT_OPTIONS)
    .default('newest')
    .openapi({
      example: 'newest',
      description: `並び順。${REVIEW_SORT_OPTIONS.join(' | ')}（既定: newest）`,
    }),
  limit: z.coerce
    .number()
    .int({ message: 'limit は整数である必要があります' })
    .min(1, { message: 'limit は 1 以上である必要があります' })
    .max(MAX_REVIEW_LIMIT, {
      message: `limit は ${String(MAX_REVIEW_LIMIT)} 以下である必要があります`,
    })
    .default(DEFAULT_REVIEW_LIMIT)
    .openapi({ example: 20, description: '1 ページの件数（1〜100、既定 20）' }),
  filter_rating: z.coerce
    .number()
    .int({ message: 'filter_rating は整数である必要があります' })
    .min(1, { message: 'filter_rating は 1〜5 の整数である必要があります' })
    .max(5, { message: 'filter_rating は 1〜5 の整数である必要があります' })
    .optional()
    .openapi({ example: 5, description: '星評価で絞り込む（1〜5）' }),
  verified_only: z.enum(['true', 'false']).optional().openapi({
    example: 'true',
    description: '購入済みバッジ付きのレビューのみに絞る',
  }),
  after: z.string().optional().openapi({
    description: '前ページの next_cursor。先頭ページでは省略する。',
  }),
});

export type ListReviewsQuery = z.infer<typeof ListReviewsQuerySchema>;

// カーソルの中身（不透明トークンをデコードした後の形）。
// 改竄されていれば 400 に倒す（cake / order と同じ方針）。
//   sort         … カーソル発行時の並び順。次ページ要求の sort と一致必須。
//   createdAt    … 最終行の created_at（ISO 8601 文字列）
//   id           … tiebreaker
//   helpfulCount … sort=helpful のときだけ載る
export const ReviewCursorSchema = z.object({
  sort: z.enum(REVIEW_SORT_OPTIONS),
  createdAt: z.string(),
  id: z.string().uuid(),
  helpfulCount: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Response: GET /v1/cakes/{cake_id}/reviews
// ---------------------------------------------------------------------------
export const ListReviewsResponseSchema = z
  .object({
    reviews: z.array(ReviewResponseSchema),
    next_cursor: z.string().nullable().openapi({
      example: 'eyJzb3J0...',
      description: '次ページ取得用カーソル（無ければ null）',
    }),
    has_more: z.boolean().openapi({ example: true }),
    stats: ReviewStatsResponseSchema,
  })
  .openapi('ListReviewsResponse');

export type ListReviewsResponse = z.infer<typeof ListReviewsResponseSchema>;

// ---------------------------------------------------------------------------
// Request: POST /v1/cakes/{cake_id}/reviews
//   制約は domain（Review.create / Rating.of）と一致させる（多重防御）。
// ---------------------------------------------------------------------------
export const PostReviewRequestSchema = z
  .object({
    rating: z
      .number()
      .int({ message: '星評価は整数である必要があります' })
      .min(1, { message: '星評価は 1〜5 の整数である必要があります' })
      .max(5, { message: '星評価は 1〜5 の整数である必要があります' })
      .openapi({ example: 5 }),
    title: z
      .string()
      .min(1, { message: 'タイトルは必須です' })
      .max(100, { message: 'タイトルは 100 文字以内です' })
      .openapi({ example: 'とても美味しかった' }),
    body: z
      .string()
      .min(1, { message: '本文は必須です' })
      .max(2000, { message: '本文は 2000 文字以内です' })
      .openapi({ example: '生クリームの甘さが絶妙でした。リピート確定です。' }),
  })
  .openapi('PostReviewRequest');

export type PostReviewRequest = z.infer<typeof PostReviewRequestSchema>;

// ---------------------------------------------------------------------------
// 共通: エラーレスポンス（cake.dto.ts と同じ shape）
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
