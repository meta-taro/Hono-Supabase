import { describe, it, expect } from 'vitest';
import { createListCustomersUseCase } from './list-customers.usecase';
import { InMemoryCustomerRepository } from './__test-helpers__/in-memory-customer.repository';
import { Customer } from '../domain/customer';

// Phase 6 で repo.save() は廃止された（本番は handle_new_user トリガで作成される）。
// テストでは InMemoryCustomerRepository.seed() を使ってシナリオを準備する。
describe('listCustomersUseCase', () => {
  it('リポジトリが空のときは空配列を返す', async () => {
    const repo = new InMemoryCustomerRepository();
    const listCustomers = createListCustomersUseCase(repo);

    const result = await listCustomers();

    expect(result).toEqual([]);
  });

  it('保存済みの顧客をすべて返す', async () => {
    const repo = new InMemoryCustomerRepository();
    repo.seed(
      Customer.create({
        authUserId: '11111111-1111-4111-8111-111111111111',
        name: '田中太郎',
        email: 'tanaka@example.com',
      }),
    );
    repo.seed(
      Customer.create({
        authUserId: '22222222-2222-4222-8222-222222222222',
        name: '山田花子',
        email: 'yamada@example.com',
      }),
    );
    const listCustomers = createListCustomersUseCase(repo);

    const result = await listCustomers();

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(['山田花子', '田中太郎']);
  });
});
