import { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ShopReviewHelpfulVoteRepository } from '@/modules/reviews/domain/shop-review-helpful-vote.repository';
import type { ShopReviewRepository } from '@/modules/reviews/domain/shop-review.repository';
import {
  ShopReviewForbiddenError,
  ShopReviewNotFoundError,
} from '@/modules/reviews/domain/shop-review.errors';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { HelpfulVoteResult } from './helpful-vote-result';

export interface VoteShopReviewHelpfulInput {
  reviewId: string;
  userId: string; // 投票者の auth.users.id
}

// 店舗レビューへの「役立った」投票を付与する UseCase（cake 版と同手順・対象が店舗レビュー）。
//   1. reviewId を VO 化
//   2. published なレビューが無ければ 404
//   3. 自分のレビューには投票不可（403）
//   4. 投票を付与（冪等）
//   5. 現在の投票数を読み直して返す
export const createVoteShopReviewHelpfulUseCase = (
  reviewRepo: ShopReviewRepository,
  voteRepo: ShopReviewHelpfulVoteRepository,
  logger: AppLogger,
) => {
  return async (input: VoteShopReviewHelpfulInput): Promise<HelpfulVoteResult> => {
    const reviewId = ReviewId.from(input.reviewId);

    const review = await reviewRepo.findById(reviewId);
    if (!review || review.status !== 'published') {
      throw new ShopReviewNotFoundError(input.reviewId);
    }
    if (review.userId === input.userId) {
      throw new ShopReviewForbiddenError('自分のレビューには「役立った」を付けられません');
    }

    await voteRepo.add(reviewId, input.userId);
    const helpfulCount = await voteRepo.countByReview(reviewId);
    logger.info(
      { reviewId: input.reviewId, userId: input.userId, helpfulCount },
      'Shop review helpful vote added',
    );
    return { helpfulCount, voted: true };
  };
};

export type VoteShopReviewHelpfulUseCase = ReturnType<typeof createVoteShopReviewHelpfulUseCase>;
