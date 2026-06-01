import { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ShopReviewHelpfulVoteRepository } from '@/modules/reviews/domain/shop-review-helpful-vote.repository';
import type { ShopReviewRepository } from '@/modules/reviews/domain/shop-review.repository';
import { ShopReviewNotFoundError } from '@/modules/reviews/domain/shop-review.errors';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { HelpfulVoteResult } from './helpful-vote-result';

export interface RemoveShopReviewHelpfulInput {
  reviewId: string;
  userId: string; // 投票者の auth.users.id
}

// 店舗レビューへの「役立った」投票を取消する UseCase。
//   1. reviewId を VO 化
//   2. published なレビューが無ければ 404
//   3. 投票を取消（未投票なら no-op で冪等）。自己投票チェックは不要
//   4. 現在の投票数を読み直して返す
export const createRemoveShopReviewHelpfulUseCase = (
  reviewRepo: ShopReviewRepository,
  voteRepo: ShopReviewHelpfulVoteRepository,
  logger: AppLogger,
) => {
  return async (input: RemoveShopReviewHelpfulInput): Promise<HelpfulVoteResult> => {
    const reviewId = ReviewId.from(input.reviewId);

    const review = await reviewRepo.findById(reviewId);
    if (!review || review.status !== 'published') {
      throw new ShopReviewNotFoundError(input.reviewId);
    }

    await voteRepo.remove(reviewId, input.userId);
    const helpfulCount = await voteRepo.countByReview(reviewId);
    logger.info(
      { reviewId: input.reviewId, userId: input.userId, helpfulCount },
      'Shop review helpful vote removed',
    );
    return { helpfulCount, voted: false };
  };
};

export type RemoveShopReviewHelpfulUseCase = ReturnType<
  typeof createRemoveShopReviewHelpfulUseCase
>;
