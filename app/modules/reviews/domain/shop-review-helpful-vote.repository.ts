import type { ReviewId } from './review-id.vo';

// 店舗レビューへの「役立った」投票の永続化 port。
//   cake レビュー版（ReviewHelpfulVoteRepository）と同形だが、対象テーブルが
//   shop_review_helpful_votes になる別 Aggregate のため interface を分けておく。
//
// トグル設計に合わせ add / remove はどちらも冪等。countByReview は対象店舗レビューの
// 現在の投票数を返す（shop_reviews.helpful_count は DB トリガでこの票数に同期される）。
export interface ShopReviewHelpfulVoteRepository {
  add(reviewId: ReviewId, userId: string): Promise<void>;
  remove(reviewId: ReviewId, userId: string): Promise<void>;
  countByReview(reviewId: ReviewId): Promise<number>;
}
