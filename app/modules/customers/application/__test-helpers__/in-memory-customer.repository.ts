import type { Customer } from '../../domain/customer';
import type { CustomerRepository } from '../../domain/customer.repository';
import type { Email } from '../../domain/email.vo';

// テスト専用のメモリ実装。
// DDD-lite の利点: UseCase を Supabase 抜きで叩ける（高速・決定的）。
// 本番ロジックには絶対に紛れ込ませないため __test-helpers__ ディレクトリに隔離する。
export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly store = new Map<string, Customer>();

  async list(): Promise<Customer[]> {
    return Array.from(this.store.values());
  }

  async findByEmail(email: Email): Promise<Customer | null> {
    for (const customer of this.store.values()) {
      if (customer.email.equals(email)) {
        return customer;
      }
    }
    return null;
  }

  async save(customer: Customer): Promise<void> {
    this.store.set(customer.id.value, customer);
  }

  // テストアサーション用のヘルパ（インターフェース外。テストからのみ呼ぶ）
  size(): number {
    return this.store.size;
  }
}
