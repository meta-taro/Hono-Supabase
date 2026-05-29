import type { CakeId } from './cake-id.vo';
import type { Review } from './review';
import type { ReviewId } from './review-id.vo';

// 一覧取得のソート順。
//   newest  … created_at DESC, id DESC（新着順。既定）
//   helpful … helpful_count DESC, created_at DESC, id DESC（参考になった順）
// 余計な軸を増やすと PostgREST のキーセット展開が複雑化するため、Phase 11 は 2 種類に絞る。
export const REVIEW_SORT_OPTIONS = ['newest', 'helpful'] as const;
export type ReviewSortOption = (typeof REVIEW_SORT_OPTIONS)[number];

// カーソル（キーセットページネーション）。
//   helpfulCount は sort=helpful のときのみ載る。それ以外は createdAt + id で十分。
//   createdAt は ISO 8601 UTC 文字列（辞書順 = 時系列順で比較が単純）。
export interface ReviewListCursor {
  sort: ReviewSortOption;
  createdAt: string;
  id: string;
  helpfulCount?: number;
}

// 一覧取得のパラメータ。
//   filterRating: 1〜5 を指定すると「その星評価のレビューだけ」に絞る（ecake.jp の星別フィルタ相当）。
//   verifiedOnly: true なら is_verified_purchaser=true のレビューだけに絞る。
export interface ListReviewsByCakeParams {
  cakeId: CakeId;
  limit: number;
  sort: ReviewSortOption;
  filterRating?: number;
  verifiedOnly?: boolean;
  after?: ReviewListCursor;
}

// 1 ページ分の結果。reviews は published のみを返す（hidden / removed は除外）。
export interface ReviewPage {
  reviews: Review[];
  nextCursor: ReviewListCursor | null;
}

// 集計（一覧 API のレスポンスに添える）。
//   average は小数 2 桁丸めを想定。0 件なら null（「まだ評価なし」を表現）。
//   distribution は星別の件数（key は 1..5）。0 件の星もキーを残す（[1..5] で固定形）。
export interface ReviewStats {
  count: number;
  average: number | null;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

// 永続化の interface は domain で定義する。
// 具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
//
// 「集計を別 query で取る」設計にしている理由:
//   - PostgREST 1 リクエストで「ページ + 全行集計」を返すのは非効率（GROUP BY と LIMIT が混在）
//   - 集計は変動が遅いので将来キャッシュしやすい（list と別経路に分けておくと差し替えやすい）
export interface ReviewRepository {
  save(review: Review): Promise<void>;
  findById(id: ReviewId): Promise<Review | null>;
  listByCake(params: ListReviewsByCakeParams): Promise<ReviewPage>;

  // cakeId 単位の集計（published のみ集計対象。hidden / removed は除外）。
  // 0 件のときは { count: 0, average: null, distribution: {1..5: 0} } を返す。
  statsByCake(cakeId: CakeId): Promise<ReviewStats>;

  // 同一 user が同一 cake に対して既存の published / hidden レビューを持つかを判定する
  // （重複投稿の検出）。removed 状態は再投稿可とみなして無視する。
  existsActiveByCakeAndUser(cakeId: CakeId, userId: string): Promise<boolean>;
}
