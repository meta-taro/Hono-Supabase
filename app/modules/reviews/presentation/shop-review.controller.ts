import type {
  ListShopReviewsInput,
  ListShopReviewsUseCase,
} from '@/modules/reviews/application/list-shop-reviews.usecase';
import type { PostShopReviewUseCase } from '@/modules/reviews/application/post-shop-review.usecase';
import type { ShopReview } from '@/modules/reviews/domain/shop-review';
import type { ReviewListCursor } from '@/modules/reviews/domain/review.repository';
import { decodeCursor, encodeCursor } from '@/shared/http/cursor';
import { ValidationError } from '@/shared/domain/errors';
import {
  ReviewCursorSchema,
  type ListShopReviewsQuery,
  type ListShopReviewsResponse,
  type PostShopReviewRequest,
  type ShopReviewResponse,
} from './shop-review.dto';

// Controller の責務:
//   - UseCase を呼び出す（業務手順は知らない）
//   - domain Entity → Response DTO の変換（VO の中身を外向きの形にほぐす）
//   - HTTP / Hono 固有 API には触れない（routes 層の仕事）
//
// 単一店舗のため cake_id のような対象パラメータは存在しない。

// domain ShopReview → API レスポンス DTO へ変換する純粋関数。
const toShopReviewResponse = (review: ShopReview): ShopReviewResponse => ({
  id: review.id.value,
  user_id: review.userId,
  rating: review.rating.value,
  title: review.title,
  body: review.body,
  is_verified_customer: review.isVerifiedCustomer,
  helpful_count: review.helpfulCount,
  created_at: review.createdAt.toISOString(),
});

// クエリから UseCase 入力を組み立てる（未指定キーは積まない＝
// exactOptionalPropertyTypes 相当の Domain 入力ルールに合わせる）。
const buildListInput = (
  query: ListShopReviewsQuery,
  after: ReviewListCursor | undefined,
): ListShopReviewsInput => {
  const input: ListShopReviewsInput = {
    limit: query.limit,
    sort: query.sort,
  };
  if (query.filter_rating !== undefined) input.filterRating = query.filter_rating;
  if (query.verified_only !== undefined) input.verifiedOnly = query.verified_only === 'true';
  if (after !== undefined) input.after = after;
  return input;
};

export interface ShopReviewControllerDeps {
  postShopReview: PostShopReviewUseCase;
  listShopReviews: ListShopReviewsUseCase;
}

export const createShopReviewController = (deps: ShopReviewControllerDeps) => ({
  // POST /v1/shop/reviews
  //   入力は routes 側で Zod 検証済み。userId は認証ミドルウェアが解決する。
  //   重複投稿は UseCase が ShopReviewAlreadyExistsError(=409) を投げる。
  post: async (userId: string, input: PostShopReviewRequest): Promise<ShopReviewResponse> => {
    const review = await deps.postShopReview({
      userId,
      rating: input.rating,
      title: input.title,
      body: input.body,
    });
    return toShopReviewResponse(review);
  },

  // GET /v1/shop/reviews
  //   after（不透明カーソル）をデコードして検証し、UseCase に渡す。
  //   - 改竄カーソルは ValidationError(400)
  //   - カーソル発行時の sort と今回 sort が不一致なら 400（並び替えで続きを保証できないため）
  //   レスポンスには 1 ページ分のレビュー + 集計（stats）を載せる。
  list: async (query: ListShopReviewsQuery): Promise<ListShopReviewsResponse> => {
    let after: ReviewListCursor | undefined;
    if (query.after) {
      const decoded = decodeCursor(query.after, ReviewCursorSchema);
      if (decoded.sort !== query.sort) {
        throw new ValidationError('カーソルとソート条件が一致しません', [
          {
            field: 'after',
            message: 'sort を変更した場合は after を付けずに先頭ページから取得してください',
          },
        ]);
      }
      after = {
        sort: decoded.sort,
        createdAt: decoded.createdAt,
        id: decoded.id,
        ...(decoded.helpfulCount !== undefined ? { helpfulCount: decoded.helpfulCount } : {}),
      };
    }

    const { page, stats } = await deps.listShopReviews(buildListInput(query, after));

    const nextCursor = page.nextCursor
      ? encodeCursor({
          sort: page.nextCursor.sort,
          createdAt: page.nextCursor.createdAt,
          id: page.nextCursor.id,
          ...(page.nextCursor.helpfulCount !== undefined
            ? { helpfulCount: page.nextCursor.helpfulCount }
            : {}),
        })
      : null;

    return {
      reviews: page.reviews.map(toShopReviewResponse),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      stats: {
        count: stats.count,
        average: stats.average,
        distribution: {
          '1': stats.distribution[1],
          '2': stats.distribution[2],
          '3': stats.distribution[3],
          '4': stats.distribution[4],
          '5': stats.distribution[5],
        },
      },
    };
  },
});

export type ShopReviewController = ReturnType<typeof createShopReviewController>;
