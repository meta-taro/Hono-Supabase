import type { Cake } from './cake';

// 永続化の interface だけを domain で定義する。
// 具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
// 依存方向は内向き: infrastructure → domain
export interface CakeRepository {
  list(): Promise<Cake[]>;
  save(cake: Cake): Promise<void>;
}
