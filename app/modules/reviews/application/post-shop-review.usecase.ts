import type { OrderHistoryChecker } from '@/modules/reviews/domain/order-history.checker';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import { ShopReviewAlreadyExistsError } from '@/modules/reviews/domain/shop-review.errors';
import type { ShopReviewRepository } from '@/modules/reviews/domain/shop-review.repository';
import type { AppLogger } from '@/shared/infrastructure/logger';

// 店舗レビュー投稿の UseCase 入力。プリミティブ型のみ受け取る（単一店舗のため cakeId なし）。
export interface PostShopReviewInput {
  userId: string; // Supabase auth.users.id
  rating: number;
  title: string;
  body: string;
}

// 業務手順:
//   1. 同一 user が既存の店舗レビュー（published / hidden）を持つなら 409 で拒否
//      （DB 側にも UNIQUE 制約を貼る多重防御だが、UseCase で先に弾けるとエラーメッセージが明確）
//   2. OrderHistoryChecker で「投稿時点で利用実績があるか」を判定し、ShopReview に snapshot
//      （注文がキャンセルされても過去の真実は変えない）
//   3. ShopReview.create() で不変条件を満たした Entity を生成（壊れた入力はここで弾かれる）
//   4. Repository に永続化
//   5. ビジネスイベントとして info ログ
export const createPostShopReviewUseCase = (
  repo: ShopReviewRepository,
  checker: OrderHistoryChecker,
  logger: AppLogger,
) => {
  return async (input: PostShopReviewInput): Promise<ShopReview> => {
    if (await repo.existsActiveByUser(input.userId)) {
      throw new ShopReviewAlreadyExistsError(input.userId);
    }

    const isVerifiedCustomer = await checker.hasOrdered(input.userId);

    const review = ShopReview.create({
      userId: input.userId,
      rating: input.rating,
      title: input.title,
      body: input.body,
      isVerifiedCustomer,
    });
    await repo.save(review);
    logger.info(
      {
        reviewId: review.id.value,
        userId: review.userId,
        rating: review.rating.value,
        isVerifiedCustomer: review.isVerifiedCustomer,
      },
      'Shop review posted',
    );
    return review;
  };
};

export type PostShopReviewUseCase = ReturnType<typeof createPostShopReviewUseCase>;
