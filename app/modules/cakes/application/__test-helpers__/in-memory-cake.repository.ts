import type { Cake } from '../../domain/cake';
import type { CakeRepository } from '../../domain/cake.repository';

// テスト専用のメモリ実装。
// DDD-lite の利点: UseCase を Supabase 抜きで叩ける（高速・決定的）。
// 本番ロジックには絶対に紛れ込ませないため __test-helpers__ ディレクトリに隔離する。
export class InMemoryCakeRepository implements CakeRepository {
  private readonly store = new Map<string, Cake>();

  async list(): Promise<Cake[]> {
    return Array.from(this.store.values());
  }

  async save(cake: Cake): Promise<void> {
    this.store.set(cake.id.value, cake);
  }

  // テストアサーション用のヘルパ（インターフェース外。テストからのみ呼ぶ）
  size(): number {
    return this.store.size;
  }
}
