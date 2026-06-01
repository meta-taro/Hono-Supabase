import type { ReviewId } from './review-id.vo';

// ケーキレビューへの「役立った」投票の永続化 port。
//   具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
//
// トグル設計（付与/取消の両対応）に合わせ、add / remove はどちらも冪等にする:
//   - add:    既に投票済みなら何もしない（INSERT ON CONFLICT DO NOTHING 相当）
//   - remove: 未投票なら何もしない（DELETE で 0 件でも成功扱い）
//   UNIQUE(user_id, review_id) により「1 ユーザー × 1 レビュー = 1 票」を保証する。
//
// countByReview は対象レビューの現在の投票数を返す。reviews.helpful_count は
// DB トリガでこの票数に同期されるため、API レスポンスの helpful_count はここから取る
// （票テーブルが投票数の単一の真実）。
export interface ReviewHelpfulVoteRepository {
  add(reviewId: ReviewId, userId: string): Promise<void>;
  remove(reviewId: ReviewId, userId: string): Promise<void>;
  countByReview(reviewId: ReviewId): Promise<number>;
}
