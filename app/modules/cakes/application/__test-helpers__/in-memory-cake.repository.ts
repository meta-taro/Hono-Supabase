import type { Cake } from '../../domain/cake';
import type {
  CakeListCursor,
  CakePage,
  CakeRepository,
  ListCakesParams,
} from '../../domain/cake.repository';

// (name, id) の複合キーで全順序を定義する。Supabase 実装の
// `ORDER BY name, id` と同じ並びを in-memory でも再現するためのもの。
const compareByNameThenId = (a: Cake, b: Cake): number => {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id.value === b.id.value) return 0;
  return a.id.value < b.id.value ? -1 : 1;
};

// キーセット条件 (name, id) > (after.name, after.id) を満たすか。
const isAfter = (cake: Cake, after: CakeListCursor): boolean => {
  if (cake.name !== after.name) return cake.name > after.name;
  return cake.id.value > after.id;
};

// テスト専用のメモリ実装。
// DDD-lite の利点: UseCase を Supabase 抜きで叩ける（高速・決定的）。
// 本番ロジックには絶対に紛れ込ませないため __test-helpers__ ディレクトリに隔離する。
export class InMemoryCakeRepository implements CakeRepository {
  private readonly store = new Map<string, Cake>();

  async list(params: ListCakesParams): Promise<CakePage> {
    const sorted = Array.from(this.store.values()).sort(compareByNameThenId);
    const candidates = params.after ? sorted.filter((c) => isAfter(c, params.after!)) : sorted;

    // limit + 1 件あれば「次ページが存在する」と判定できる（hasMore）。
    const hasMore = candidates.length > params.limit;
    const cakes = candidates.slice(0, params.limit);

    const last = cakes[cakes.length - 1];
    const nextCursor = hasMore && last ? { name: last.name, id: last.id.value } : null;

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
