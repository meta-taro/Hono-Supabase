import type { Customer } from '../../domain/customer';
import type { CustomerRepository } from '../../domain/customer.repository';
import type { Email } from '../../domain/email.vo';

// テスト専用のメモリ実装。
// DDD-lite の利点: UseCase を Supabase 抜きで叩ける（高速・決定的）。
// 本番ロジックには絶対に紛れ込ませないため __test-helpers__ ディレクトリに隔離する。
//
// Phase 6 で interface から save() が外れたが、テストの seed 用ヘルパとして
// クラス内に残す（interface には公開せず、明示的に「テスト由来である」と分かる形にする）。
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

  async findByAuthUserId(authUserId: string): Promise<Customer | null> {
    for (const customer of this.store.values()) {
      if (customer.authUserId === authUserId) {
        return customer;
      }
    }
    return null;
  }

  // テストアサーション / セットアップ用ヘルパ（インターフェース外）。
  // Phase 6 では本番経路の保存は handle_new_user トリガが担うため、
  // 本番リポジトリ実装には save() を持たせない。テストでは Customer.reconstruct
  // 等で組み立てた Entity をこのヘルパで投入してシナリオを準備する。
  seed(customer: Customer): void {
    this.store.set(customer.id.value, customer);
  }

  size(): number {
    return this.store.size;
  }
}
