import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewHelpfulVoteRepository } from '@/modules/reviews/domain/review-helpful-vote.repository';
import type { ReviewId } from '@/modules/reviews/domain/review-id.vo';

const VOTES_TABLE = 'review_helpful_votes';
const REVIEWS_TABLE = 'reviews';

// review_helpful_votes への投票の付与/取消を担う。per-request の authenticated client で動く。
//   - INSERT/DELETE は RLS（auth.uid() = user_id）で「本人の票」のみ操作できる。
//   - 投票数（helpful_count）は DB トリガが reviews.helpful_count に同期する。
export class ReviewHelpfulVoteSupabaseRepository implements ReviewHelpfulVoteRepository {
  constructor(private readonly sb: SupabaseClient) {}

  async add(reviewId: ReviewId, userId: string): Promise<void> {
    // INSERT ON CONFLICT DO NOTHING 相当（ignoreDuplicates）。既に投票済みなら no-op で冪等。
    // 衝突時は行が挿入されず AFTER INSERT トリガも発火しないため二重カウントしない。
    // onConflict は UNIQUE(user_id, review_id) 制約に一致させる。
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
    // 一致行が無くてもエラーにならず 0 件削除 = no-op で冪等。
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
    // 投票数は反正規化カウンタ reviews.helpful_count から読む（トリガで同期済み）。
    // 票テーブルを直接 count しないのは、RLS の SELECT ポリシーが「本人の票のみ可視」で
    // 認証ユーザー経路だと総数（他人の票を含む）を取得できないため。published レビューの
    // helpful_count は誰でも読めるので、GET 一覧が返す表示値と必ず一致する。
    const { data, error } = await this.sb
      .from(REVIEWS_TABLE)
      .select('helpful_count')
      .eq('id', reviewId.value)
      .maybeSingle<{ helpful_count: number }>();

    if (error) {
      throw new Error(`「役立った」投票数の取得に失敗しました: ${error.message}`);
    }
    return data?.helpful_count ?? 0;
  }
}
