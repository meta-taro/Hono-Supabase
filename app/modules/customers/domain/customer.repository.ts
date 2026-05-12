import type { Customer } from './customer';
import type { Email } from './email.vo';

// 永続化の interface だけを domain で定義する。
// 具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
// 依存方向は内向き: infrastructure → domain
export interface CustomerRepository {
  list(): Promise<Customer[]>;
  // メール重複チェックを application 層で行うために提供する。
  // 実装側はインデックス付きの単一行クエリで O(1) を期待する。
  findByEmail(email: Email): Promise<Customer | null>;
  // Phase 6: JWT subject (auth.users.id) から業務 customer を引くために必要。
  // orders 等の認証必須経路で「現在のユーザの customer 行」を取得するときに使う。
  findByAuthUserId(authUserId: string): Promise<Customer | null>;
}
