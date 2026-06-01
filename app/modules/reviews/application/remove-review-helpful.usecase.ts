import { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ReviewHelpfulVoteRepository } from '@/modules/reviews/domain/review-helpful-vote.repository';
import type { ReviewRepository } from '@/modules/reviews/domain/review.repository';
import { ReviewNotFoundError } from '@/modules/reviews/domain/review.errors';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { HelpfulVoteResult } from './helpful-vote-result';

export interface RemoveReviewHelpfulInput {
  reviewId: string;
  userId: string; // 投票者の auth.users.id
}

// ケーキレビューへの「役立った」投票を取消する UseCase。
// 業務手順:
//   1. reviewId を VO 化（壊れた UUID は 400）
//   2. published なレビューが無ければ 404
//   3. 投票を取消（未投票なら no-op で冪等）。自己投票チェックは不要
//      （自分のレビューには元々投票できないため、取消は常に no-op になる）
//   4. 現在の投票数を読み直して返す
export const createRemoveReviewHelpfulUseCase = (
  reviewRepo: ReviewRepository,
  voteRepo: ReviewHelpfulVoteRepository,
  logger: AppLogger,
) => {
  return async (input: RemoveReviewHelpfulInput): Promise<HelpfulVoteResult> => {
    const reviewId = ReviewId.from(input.reviewId);

    const review = await reviewRepo.findById(reviewId);
    if (!review || review.status !== 'published') {
      throw new ReviewNotFoundError(input.reviewId);
    }

    await voteRepo.remove(reviewId, input.userId);
    const helpfulCount = await voteRepo.countByReview(reviewId);
    logger.info(
      { reviewId: input.reviewId, userId: input.userId, helpfulCount },
      'Review helpful vote removed',
    );
    return { helpfulCount, voted: false };
  };
};

export type RemoveReviewHelpfulUseCase = ReturnType<typeof createRemoveReviewHelpfulUseCase>;
