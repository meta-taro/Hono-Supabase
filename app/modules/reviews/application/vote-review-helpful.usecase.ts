import { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ReviewHelpfulVoteRepository } from '@/modules/reviews/domain/review-helpful-vote.repository';
import type { ReviewRepository } from '@/modules/reviews/domain/review.repository';
import { ReviewForbiddenError, ReviewNotFoundError } from '@/modules/reviews/domain/review.errors';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { HelpfulVoteResult } from './helpful-vote-result';

export interface VoteReviewHelpfulInput {
  reviewId: string;
  userId: string; // 投票者の auth.users.id
}

// ケーキレビューへの「役立った」投票を付与する UseCase。
// 業務手順:
//   1. reviewId を VO 化（壊れた UUID は 400）
//   2. published なレビューが無ければ 404（hidden / removed / 不存在はすべて対象外）
//   3. 自分のレビューには投票不可（403）
//   4. 投票を付与（既に投票済みなら no-op で冪等。UNIQUE(user_id, review_id) が安全網）
//   5. 現在の投票数を読み直して返す（DB トリガで helpful_count に同期済み）
export const createVoteReviewHelpfulUseCase = (
  reviewRepo: ReviewRepository,
  voteRepo: ReviewHelpfulVoteRepository,
  logger: AppLogger,
) => {
  return async (input: VoteReviewHelpfulInput): Promise<HelpfulVoteResult> => {
    const reviewId = ReviewId.from(input.reviewId);

    const review = await reviewRepo.findById(reviewId);
    if (!review || review.status !== 'published') {
      throw new ReviewNotFoundError(input.reviewId);
    }
    if (review.userId === input.userId) {
      throw new ReviewForbiddenError('自分のレビューには「役立った」を付けられません');
    }

    await voteRepo.add(reviewId, input.userId);
    const helpfulCount = await voteRepo.countByReview(reviewId);
    logger.info(
      { reviewId: input.reviewId, userId: input.userId, helpfulCount },
      'Review helpful vote added',
    );
    return { helpfulCount, voted: true };
  };
};

export type VoteReviewHelpfulUseCase = ReturnType<typeof createVoteReviewHelpfulUseCase>;
