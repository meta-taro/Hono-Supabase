import type { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ShopReviewHelpfulVoteRepository } from '@/modules/reviews/domain/shop-review-helpful-vote.repository';

// テスト用の in-memory 実装（cake 版と同形・対象が店舗レビュー）。
//   - Map<reviewId, Set<userId>> で保持。add / remove は Set 操作で自然に冪等。
//   - countByReview は Set のサイズを返す。
export class InMemoryShopReviewHelpfulVoteRepository implements ShopReviewHelpfulVoteRepository {
  private readonly byReview = new Map<string, Set<string>>();

  async add(reviewId: ReviewId, userId: string): Promise<void> {
    const set = this.byReview.get(reviewId.value) ?? new Set<string>();
    set.add(userId);
    this.byReview.set(reviewId.value, set);
  }

  async remove(reviewId: ReviewId, userId: string): Promise<void> {
    this.byReview.get(reviewId.value)?.delete(userId);
  }

  async countByReview(reviewId: ReviewId): Promise<number> {
    return this.byReview.get(reviewId.value)?.size ?? 0;
  }

  // テスト補助: 指定ユーザーが投票済みかを確認する。
  has(reviewId: ReviewId, userId: string): boolean {
    return this.byReview.get(reviewId.value)?.has(userId) ?? false;
  }
}
