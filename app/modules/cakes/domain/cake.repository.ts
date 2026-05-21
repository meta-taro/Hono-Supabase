import type { SortKey } from '@/shared/http/sort';
import type { Cake } from './cake';

// ソート可能なフィールド（DB 列に対応）。presentation 層でも許可リストとして使う。
export const CAKE_SORT_FIELDS = ['name', 'price', 'stock'] as const;
export type CakeSortField = (typeof CAKE_SORT_FIELDS)[number];
export type CakeSortKey = SortKey<CakeSortField>;

// API の既定の並び順（クライアントが ?sort を省略したとき）。
// 「既定値」は presentation の決定だが、repository 実装のフォールバックでも
// 同じ並びを使うため domain 側に 1 か所だけ定義して両者で共有する。
export const DEFAULT_CAKE_SORT: readonly CakeSortKey[] = [{ field: 'name', direction: 'asc' }];

// 絞り込み条件。未指定（undefined）のキーは「条件なし」を意味する。
//   available … true: 在庫あり(stock > 0) / false: 在庫切れ(stock = 0)
//   minPrice / maxPrice … 価格の下限・上限（両端含む）
//   nameSearch … ケーキ名のあいまい検索（全文検索）。infrastructure 実装側で
//                PGroonga（`search_cakes` RPC）に委譲する。in-memory 実装は
//                部分一致で近似する（PGroonga の挙動は JS では再現できないため、
//                厳密な日本語 N-gram 一致は workers/integration プールで担保する）。
export interface CakeFilter {
  available?: boolean;
  minPrice?: number;
  maxPrice?: number;
  nameSearch?: string;
}

// カーソルベース（キーセット）ページネーションの位置情報。
//   sort   … このカーソルを発行したときの並び順。次ページ要求の sort と一致しない
//            限りキーセットの整合が崩れるため、presentation 層で突き合わせ検証する。
//   values … sort 各フィールドにおける「最終行の値」。キーセット条件の比較対象。
//   id     … 全フィールド同値時の最終 tiebreaker（id は一意なので全順序が確定する）。
export interface CakeListCursor {
  sort: CakeSortKey[];
  values: Partial<Record<CakeSortField, string | number>>;
  id: string;
}

// 一覧取得のパラメータ。
//   sort / filter は presentation が必ず組み立てて渡す（既定値の決定は presentation の責務）。
//   after を起点に limit 件を sort 順で返す。after 省略時は先頭ページ。
export interface ListCakesParams {
  limit: number;
  sort: CakeSortKey[];
  filter: CakeFilter;
  after?: CakeListCursor;
}

// 1 ページ分の結果。nextCursor が null なら以降のページは無い。
export interface CakePage {
  cakes: Cake[];
  nextCursor: CakeListCursor | null;
}

// 永続化の interface だけを domain で定義する。
// 具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
// 依存方向は内向き: infrastructure → domain
export interface CakeRepository {
  list(params: ListCakesParams): Promise<CakePage>;
  save(cake: Cake): Promise<void>;
}
