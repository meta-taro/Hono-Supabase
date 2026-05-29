import type { ReviewListCursor, ReviewSortOption, ReviewStats } from './review.repository';
import type { ReviewId } from './review-id.vo';
import type { ShopReview } from './shop-review';

// ソート順（ReviewSortOption）・カーソル（ReviewListCursor）・集計（ReviewStats）は
// cakes レビューと同形のため reviews コンテキスト内で再利用する（cake 非依存の汎用型）。
// cakeId を持たない点だけが cakes 版（ListReviewsByCakeParams）と異なる。

// 一覧取得のパラメータ（単一店舗のため cakeId なし）。
//   filterRating: 1〜5 を指定すると「その星評価のレビューだけ」に絞る。
//   verifiedOnly: true なら is_verified_customer=true のレビューだけに絞る。
export interface ListShopReviewsParams {
  limit: number;
  sort: ReviewSortOption;
  filterRating?: number;
  verifiedOnly?: boolean;
  after?: ReviewListCursor;
}

// 1 ページ分の結果。reviews は published のみを返す（hidden / removed は除外）。
export interface ShopReviewPage {
  reviews: ShopReview[];
  nextCursor: ReviewListCursor | null;
}

// 永続化の interface は domain で定義する。
// 具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
export interface ShopReviewRepository {
  save(review: ShopReview): Promise<void>;
  findById(id: ReviewId): Promise<ShopReview | null>;
  list(params: ListShopReviewsParams): Promise<ShopReviewPage>;

  // 店舗全体の集計（published のみ集計対象。hidden / removed は除外）。
  // 0 件のときは { count: 0, average: null, distribution: {1..5: 0} } を返す。
  stats(): Promise<ReviewStats>;

  // 同一 user が既存の published / hidden 店舗レビューを持つかを判定する
  // （重複投稿の検出）。removed 状態は再投稿可とみなして無視する。
  existsActiveByUser(userId: string): Promise<boolean>;
}
