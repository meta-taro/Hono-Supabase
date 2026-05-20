import type { Cake } from './cake';

// カーソルベース（キーセット）ページネーションの位置情報。
// name は一意でないため、安定した順序を保つには (name, id) の複合キーが要る。
// id まで含めることで「同名ケーキが境界をまたぐ」場合でも行の取りこぼし/重複が起きない。
export interface CakeListCursor {
  name: string;
  id: string;
}

// 一覧取得のパラメータ。after を起点に limit 件を name 昇順で返す。
// after を省略すると先頭ページ。
export interface ListCakesParams {
  limit: number;
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
