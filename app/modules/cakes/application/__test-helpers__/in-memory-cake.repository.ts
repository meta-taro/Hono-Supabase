import type { Cake } from '../../domain/cake';
import type {
  CakeFilter,
  CakeListCursor,
  CakePage,
  CakeRepository,
  CakeSortField,
  CakeSortKey,
  ListCakesParams,
} from '../../domain/cake.repository';

// Cake から指定フィールドの比較用の値を取り出す。
// （Supabase 実装の ORDER BY 対象列と一致させるためのアダプタ）
const valueOf = (cake: Cake, field: CakeSortField): string | number => {
  switch (field) {
    case 'name':
      return cake.name;
    case 'price':
      return cake.price.value;
    case 'stock':
      return cake.stock;
  }
};

// sort（複数フィールド + 方向）に id 昇順 tiebreaker を足した全順序の比較関数。
// Supabase 実装の `.order(field).order('id')` と同じ並びを再現する。
const makeComparator =
  (sort: CakeSortKey[]) =>
  (a: Cake, b: Cake): number => {
    for (const { field, direction } of sort) {
      const av = valueOf(a, field);
      const bv = valueOf(b, field);
      if (av !== bv) {
        const cmp = av < bv ? -1 : 1;
        return direction === 'asc' ? cmp : -cmp;
      }
    }
    if (a.id.value === b.id.value) return 0;
    return a.id.value < b.id.value ? -1 : 1; // id は常に昇順
  };

// キーセット条件: sort 順で after より「厳密に後ろ」の行か。
// 先頭フィールドから順に値を比べ、差が出た時点で方向に応じて判定。
// 全フィールド同値なら id 昇順で判定（同値行の取りこぼし/重複防止）。
const isAfterCursor = (cake: Cake, after: CakeListCursor): boolean => {
  for (const { field, direction } of after.sort) {
    const cv = valueOf(cake, field);
    const av = after.values[field];
    if (av === undefined) continue;
    if (cv !== av) {
      const greater = cv > av;
      return direction === 'asc' ? greater : !greater;
    }
  }
  return cake.id.value > after.id;
};

// CakeFilter を満たすか（未指定キーは条件なし）。
const matchesFilter = (cake: Cake, filter: CakeFilter): boolean => {
  if (filter.available === true && !(cake.stock > 0)) return false;
  if (filter.available === false && cake.stock !== 0) return false;
  if (filter.minPrice !== undefined && cake.price.value < filter.minPrice) return false;
  if (filter.maxPrice !== undefined && cake.price.value > filter.maxPrice) return false;
  if (
    filter.nameContains !== undefined &&
    !cake.name.toLowerCase().includes(filter.nameContains.toLowerCase())
  ) {
    return false;
  }
  return true;
};

// テスト専用のメモリ実装。
// DDD-lite の利点: UseCase を Supabase 抜きで叩ける（高速・決定的）。
// 本番ロジックには絶対に紛れ込ませないため __test-helpers__ ディレクトリに隔離する。
export class InMemoryCakeRepository implements CakeRepository {
  private readonly store = new Map<string, Cake>();

  async list(params: ListCakesParams): Promise<CakePage> {
    const filtered = Array.from(this.store.values()).filter((c) => matchesFilter(c, params.filter));
    const sorted = filtered.sort(makeComparator(params.sort));
    const candidates = params.after
      ? sorted.filter((c) => isAfterCursor(c, params.after!))
      : sorted;

    // limit + 1 件あれば「次ページが存在する」と判定できる（hasMore）。
    const hasMore = candidates.length > params.limit;
    const cakes = candidates.slice(0, params.limit);

    const last = cakes[cakes.length - 1];
    const nextCursor =
      hasMore && last
        ? {
            sort: params.sort,
            values: Object.fromEntries(
              params.sort.map((key) => [key.field, valueOf(last, key.field)]),
            ) as Partial<Record<CakeSortField, string | number>>,
            id: last.id.value,
          }
        : null;

    return { cakes, nextCursor };
  }

  async save(cake: Cake): Promise<void> {
    this.store.set(cake.id.value, cake);
  }

  // テストアサーション用のヘルパ（インターフェース外。テストからのみ呼ぶ）
  size(): number {
    return this.store.size;
  }
}
