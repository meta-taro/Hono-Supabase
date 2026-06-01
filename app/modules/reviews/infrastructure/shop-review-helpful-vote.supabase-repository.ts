import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type { ShopReviewHelpfulVoteRepository } from '@/modules/reviews/domain/shop-review-helpful-vote.repository';

const VOTES_TABLE = 'shop_review_helpful_votes';
const SHOP_REVIEWS_TABLE = 'shop_reviews';

// shop_review_helpful_votes への投票の付与/取消を担う（cake 版と同形・対象が店舗レビュー）。
//   投票数は DB トリガが shop_reviews.helpful_count に同期する。
export class ShopReviewHelpfulVoteSupabaseRepository implements ShopReviewHelpfulVoteRepository {
  constructor(private readonly sb: SupabaseClient) {}

  async add(reviewId: ReviewId, userId: string): Promise<void> {
    // INSERT ON CONFLICT DO NOTHING 相当（ignoreDuplicates）。既に投票済みなら no-op で冪等。
    const { error } = await this.sb
      .from(VOTES_TABLE)
      .upsert(
        { review_id: reviewId.value, user_id: userId },
        { ignoreDuplicates: true, onConflict: 'user_id,review_id' },
      );

    if (error) {
      throw new Error(`「役立った」投票の付与に失敗しました: ${error.message}`);
    }
  }

  async remove(reviewId: ReviewId, userId: string): Promise<void> {
    const { error } = await this.sb
      .from(VOTES_TABLE)
      .delete()
      .eq('review_id', reviewId.value)
      .eq('user_id', userId);

    if (error) {
      throw new Error(`「役立った」投票の取消に失敗しました: ${error.message}`);
    }
  }

  async countByReview(reviewId: ReviewId): Promise<number> {
    // cake 版と同理由で反正規化カウンタ shop_reviews.helpful_count から読む
    // （票テーブル直接 count は RLS で本人の票のみ可視になり総数が取れないため）。
    const { data, error } = await this.sb
      .from(SHOP_REVIEWS_TABLE)
      .select('helpful_count')
      .eq('id', reviewId.value)
      .maybeSingle<{ helpful_count: number }>();

    if (error) {
      throw new Error(`「役立った」投票数の取得に失敗しました: ${error.message}`);
    }
    return data?.helpful_count ?? 0;
  }
}
