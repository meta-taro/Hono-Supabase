import { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import { Review } from '@/modules/reviews/domain/review';
import type { ReviewRepository } from '@/modules/reviews/domain/review.repository';
import { ReviewAlreadyExistsError } from '@/modules/reviews/domain/review.errors';
import type { VerifiedPurchaserChecker } from '@/modules/reviews/domain/verified-purchaser.checker';
import type { AppLogger } from '@/shared/infrastructure/logger';

// レビュー投稿の UseCase 入力。プリミティブ型のみ受け取り、
// VO 化（CakeId 等）はこの UseCase の中で行う（呼び出し側に VO を露出させない）。
export interface PostReviewInput {
  cakeId: string;
  userId: string; // Supabase auth.users.id
  rating: number;
  title: string;
  body: string;
}

// 業務手順:
//   1. CakeId を VO 化（壊れた UUID は 400）
//   2. 同一 user が同一 cake に既存レビュー（published / hidden）を持つなら 409 で拒否
//      （DB 側にも UNIQUE 制約を貼る多重防御だが、UseCase で先に弾けるとエラーメッセージが明確）
//   3. VerifiedPurchaserChecker で「投稿時点で購入済みか」を判定し、Review に snapshot
//      （注文がキャンセルされても過去の真実は変えない）
//   4. Review.create() で不変条件を満たした Entity を生成（壊れた入力はここで弾かれる）
//   5. Repository に永続化
//   6. ビジネスイベントとして info ログ
export const createPostReviewUseCase = (
  repo: ReviewRepository,
  checker: VerifiedPurchaserChecker,
  logger: AppLogger,
) => {
  return async (input: PostReviewInput): Promise<Review> => {
    const cakeId = CakeId.from(input.cakeId);

    if (await repo.existsActiveByCakeAndUser(cakeId, input.userId)) {
      throw new ReviewAlreadyExistsError(cakeId.value, input.userId);
    }

    const isVerifiedPurchaser = await checker.hasPurchased(input.userId, cakeId);

    const review = Review.create({
      cakeId,
      userId: input.userId,
      rating: input.rating,
      title: input.title,
      body: input.body,
      isVerifiedPurchaser,
    });
    await repo.save(review);
    logger.info(
      {
        reviewId: review.id.value,
        cakeId: review.cakeId.value,
        userId: review.userId,
        rating: review.rating.value,
        isVerifiedPurchaser: review.isVerifiedPurchaser,
      },
      'Review posted',
    );
    return review;
  };
};

export type PostReviewUseCase = ReturnType<typeof createPostReviewUseCase>;
