import type {
  ListReviewsByCakeInput,
  ListReviewsByCakeUseCase,
} from '@/modules/reviews/application/list-reviews-by-cake.usecase';
import type { PostReviewUseCase } from '@/modules/reviews/application/post-review.usecase';
import type { Review } from '@/modules/reviews/domain/review';
import type { ReviewListCursor } from '@/modules/reviews/domain/review.repository';
import { decodeCursor, encodeCursor } from '@/shared/http/cursor';
import { ValidationError } from '@/shared/domain/errors';
import {
  ReviewCursorSchema,
  type ListReviewsQuery,
  type ListReviewsResponse,
  type PostReviewRequest,
  type ReviewResponse,
} from './review.dto';

// Controller の責務:
//   - UseCase を呼び出す（業務手順は知らない）
//   - domain Entity → Response DTO の変換（VO の中身を外向きの形にほぐす）
//   - HTTP / Hono 固有 API には触れない（routes 層の仕事）
//
// cake / order controller と同じく、関数の集合（メソッド群）で実装する。

// domain Review → API レスポンス DTO へ変換する純粋関数。
//   - id / cake_id は VO の .value
//   - rating は Rating VO の .value
//   - created_at は ISO 8601 UTC 文字列に正規化
const toReviewResponse = (review: Review): ReviewResponse => ({
  id: review.id.value,
  cake_id: review.cakeId.value,
  user_id: review.userId,
  rating: review.rating.value,
  title: review.title,
  body: review.body,
  is_verified_purchaser: review.isVerifiedPurchaser,
  helpful_count: review.helpfulCount,
  created_at: review.createdAt.toISOString(),
});

// クエリから UseCase 入力を組み立てる（未指定キーは積まない＝
// exactOptionalPropertyTypes 相当の Domain 入力ルールに合わせる）。
const buildListInput = (
  cakeId: string,
  query: ListReviewsQuery,
  after: ReviewListCursor | undefined,
): ListReviewsByCakeInput => {
  const input: ListReviewsByCakeInput = {
    cakeId,
    limit: query.limit,
    sort: query.sort,
  };
  if (query.filter_rating !== undefined) input.filterRating = query.filter_rating;
  if (query.verified_only !== undefined) input.verifiedOnly = query.verified_only === 'true';
  if (after !== undefined) input.after = after;
  return input;
};

export interface ReviewControllerDeps {
  postReview: PostReviewUseCase;
  listReviewsByCake: ListReviewsByCakeUseCase;
}

export const createReviewController = (deps: ReviewControllerDeps) => ({
  // POST /v1/cakes/{cake_id}/reviews
  //   入力は routes 側で Zod 検証済み。userId は認証ミドルウェアが解決する。
  //   重複投稿は UseCase が ReviewAlreadyExistsError(=409) を投げる。
  post: async (
    cakeId: string,
    userId: string,
    input: PostReviewRequest,
  ): Promise<ReviewResponse> => {
    const review = await deps.postReview({
      cakeId,
      userId,
      rating: input.rating,
      title: input.title,
      body: input.body,
    });
    return toReviewResponse(review);
  },

  // GET /v1/cakes/{cake_id}/reviews
  //   after（不透明カーソル）をデコードして検証し、UseCase に渡す。
  //   - 改竄カーソルは ValidationError(400)
  //   - カーソル発行時の sort と今回 sort が不一致なら 400（並び替えで続きを保証できないため）
  //   レスポンスには 1 ページ分のレビュー + 集計（stats）を載せる。
  list: async (cakeId: string, query: ListReviewsQuery): Promise<ListReviewsResponse> => {
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

    const { page, stats } = await deps.listReviewsByCake(buildListInput(cakeId, query, after));

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
      reviews: page.reviews.map(toReviewResponse),
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

export type ReviewController = ReturnType<typeof createReviewController>;
