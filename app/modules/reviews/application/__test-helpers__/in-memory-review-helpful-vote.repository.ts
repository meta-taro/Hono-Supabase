import type { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ReviewHelpfulVoteRepository } from '@/modules/reviews/domain/review-helpful-vote.repository';

// テスト用の in-memory 実装。
//   - Map<reviewId, Set<userId>> で保持。reviewId ごとに投票者集合を持つ。
//   - add / remove は Set 操作で自然に冪等（重複追加・未存在削除はどちらも no-op）。
//   - countByReview は Set のサイズを返す（= 反正規化カウンタの真実）。
// 実 DB のトリガによる helpful_count 同期は infrastructure 層の workers プールで検証する。
export class InMemoryReviewHelpfulVoteRepository implements ReviewHelpfulVoteRepository {
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
