import { z } from '@hono/zod-openapi';
import { REVIEW_SORT_OPTIONS } from '@/modules/reviews/domain/review.repository';
import {
  DEFAULT_REVIEW_LIMIT,
  ErrorResponseSchema,
  MAX_REVIEW_LIMIT,
  ReviewCursorSchema,
  ReviewStatsResponseSchema,
} from './review.dto';

// 店舗レビュー（単一店舗）用 DTO。
//   エンドポイントは /v1/shop/reviews（パスパラメータ無し = cake_id を取らない）。
//   集計（stats）・カーソル・エラー・ページネーション定数は cake レビューと同一構造なので
//   review.dto.ts の共通スキーマを同一コンテキスト内で再利用する（重複を避ける）。

export {
  DEFAULT_REVIEW_LIMIT,
  ErrorResponseSchema,
  MAX_REVIEW_LIMIT,
  ReviewCursorSchema,
  ReviewStatsResponseSchema,
};

// ---------------------------------------------------------------------------
// Response: 店舗レビュー 1 件
//   cake レビューとの差分: cake_id を持たず、バッジ名が is_verified_customer。
// ---------------------------------------------------------------------------
export const ShopReviewResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '22222222-2222-4222-8222-222222222222' }),
    // 投稿者は表示用の文字列 ID のみ。ユーザー名や email は外に晒さない。
    user_id: z.string().openapi({ example: 'auth-user-abcdef' }),
    rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
    title: z.string().openapi({ example: '雰囲気がよい' }),
    body: z.string().openapi({ example: '接客が丁寧で居心地のよい店でした。' }),
    is_verified_customer: z.boolean().openapi({
      example: true,
      description: '投稿時点で利用実績（PLACED 注文）があったか（snapshot）',
    }),
    helpful_count: z.number().int().min(0).openapi({ example: 12 }),
    created_at: z.string().datetime().openapi({ example: '2026-05-29T10:00:00.000Z' }),
  })
  .openapi('ShopReview');

export type ShopReviewResponse = z.infer<typeof ShopReviewResponseSchema>;

// ---------------------------------------------------------------------------
// Request: GET /v1/shop/reviews のクエリ
//   sort / limit / filter_rating / verified_only / after は cake レビューと同一。
// ---------------------------------------------------------------------------
export const ListShopReviewsQuerySchema = z.object({
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
    description: '利用客バッジ付きのレビューのみに絞る',
  }),
  after: z.string().optional().openapi({
    description: '前ページの next_cursor。先頭ページでは省略する。',
  }),
});

export type ListShopReviewsQuery = z.infer<typeof ListShopReviewsQuerySchema>;

// ---------------------------------------------------------------------------
// Response: GET /v1/shop/reviews
// ---------------------------------------------------------------------------
export const ListShopReviewsResponseSchema = z
  .object({
    reviews: z.array(ShopReviewResponseSchema),
    next_cursor: z.string().nullable().openapi({
      example: 'eyJzb3J0...',
      description: '次ページ取得用カーソル（無ければ null）',
    }),
    has_more: z.boolean().openapi({ example: true }),
    stats: ReviewStatsResponseSchema,
  })
  .openapi('ListShopReviewsResponse');

export type ListShopReviewsResponse = z.infer<typeof ListShopReviewsResponseSchema>;

// ---------------------------------------------------------------------------
// Request: POST /v1/shop/reviews
//   制約は domain（ShopReview.create / Rating.of）と一致させる（多重防御）。
// ---------------------------------------------------------------------------
export const PostShopReviewRequestSchema = z
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
      .openapi({ example: '雰囲気がよい' }),
    body: z
      .string()
      .min(1, { message: '本文は必須です' })
      .max(2000, { message: '本文は 2000 文字以内です' })
      .openapi({ example: '接客が丁寧で居心地のよい店でした。また来ます。' }),
  })
  .openapi('PostShopReviewRequest');

export type PostShopReviewRequest = z.infer<typeof PostShopReviewRequestSchema>;
