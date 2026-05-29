import { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import type {
  ListReviewsByCakeParams,
  ReviewListCursor,
  ReviewPage,
  ReviewRepository,
  ReviewSortOption,
  ReviewStats,
} from '@/modules/reviews/domain/review.repository';

// 一覧 API の入力。
//   - cakeId はプリミティブで受け取り、UseCase 内で VO 化する。
//   - after は controller がカーソル文字列をデコード済みの構造体として渡してくる。
export interface ListReviewsByCakeInput {
  cakeId: string;
  limit: number;
  sort: ReviewSortOption;
  filterRating?: number;
  verifiedOnly?: boolean;
  after?: ReviewListCursor;
}

// 一覧 API のレスポンス。
//   - page: 1 ページ分のレビュー + 次ページ用カーソル
//   - stats: cake 全体の集計（count / average / 星別 distribution）
// 集計を 1 リクエストで返す理由は ecake.jp 等の UI が「平均 4.5 (123 件)」をリスト上部に
// 常時出すため。クライアントが list と stats を別 API として叩く設計だと往復が増える。
export interface ListReviewsByCakeOutput {
  page: ReviewPage;
  stats: ReviewStats;
}

// 業務手順:
//   1. CakeId を VO 化（壊れた UUID は 400）
//   2. listByCake と statsByCake を Promise.all で並列実行（独立クエリなのでまとめて待つ）
export const createListReviewsByCakeUseCase = (repo: ReviewRepository) => {
  return async (input: ListReviewsByCakeInput): Promise<ListReviewsByCakeOutput> => {
    const cakeId = CakeId.from(input.cakeId);

    const listParams: ListReviewsByCakeParams = {
      cakeId,
      limit: input.limit,
      sort: input.sort,
      ...(input.filterRating !== undefined ? { filterRating: input.filterRating } : {}),
      ...(input.verifiedOnly !== undefined ? { verifiedOnly: input.verifiedOnly } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    };

    const [page, stats] = await Promise.all([
      repo.listByCake(listParams),
      repo.statsByCake(cakeId),
    ]);

    return { page, stats };
  };
};

export type ListReviewsByCakeUseCase = ReturnType<typeof createListReviewsByCakeUseCase>;
