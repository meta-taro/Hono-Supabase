import type {
  ReviewListCursor,
  ReviewSortOption,
  ReviewStats,
} from '@/modules/reviews/domain/review.repository';
import type {
  ListShopReviewsParams,
  ShopReviewPage,
  ShopReviewRepository,
} from '@/modules/reviews/domain/shop-review.repository';

// 一覧 API の入力（単一店舗のため cakeId なし）。
//   - after は controller がカーソル文字列をデコード済みの構造体として渡してくる。
export interface ListShopReviewsInput {
  limit: number;
  sort: ReviewSortOption;
  filterRating?: number;
  verifiedOnly?: boolean;
  after?: ReviewListCursor;
}

// 一覧 API のレスポンス。
//   - page: 1 ページ分のレビュー + 次ページ用カーソル
//   - stats: 店舗全体の集計（count / average / 星別 distribution）
export interface ListShopReviewsOutput {
  page: ShopReviewPage;
  stats: ReviewStats;
}

// 業務手順:
//   - list と stats を Promise.all で並列実行（独立クエリなのでまとめて待つ）
export const createListShopReviewsUseCase = (repo: ShopReviewRepository) => {
  return async (input: ListShopReviewsInput): Promise<ListShopReviewsOutput> => {
    const listParams: ListShopReviewsParams = {
      limit: input.limit,
      sort: input.sort,
      ...(input.filterRating !== undefined ? { filterRating: input.filterRating } : {}),
      ...(input.verifiedOnly !== undefined ? { verifiedOnly: input.verifiedOnly } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    };

    const [page, stats] = await Promise.all([repo.list(listParams), repo.stats()]);

    return { page, stats };
  };
};

export type ListShopReviewsUseCase = ReturnType<typeof createListShopReviewsUseCase>;
