import { describe, it, expect } from 'vitest';
import { createListCustomersUseCase } from './list-customers.usecase';
import { InMemoryCustomerRepository } from './__test-helpers__/in-memory-customer.repository';
import { Customer } from '../domain/customer';

describe('listCustomersUseCase', () => {
  it('リポジトリが空のときは空配列を返す', async () => {
    const repo = new InMemoryCustomerRepository();
    const listCustomers = createListCustomersUseCase(repo);

    const result = await listCustomers();

    expect(result).toEqual([]);
  });

  it('保存済みの顧客をすべて返す', async () => {
    const repo = new InMemoryCustomerRepository();
    await repo.save(Customer.create({ name: '田中太郎', email: 'tanaka@example.com' }));
    await repo.save(Customer.create({ name: '山田花子', email: 'yamada@example.com' }));
    const listCustomers = createListCustomersUseCase(repo);

    const result = await listCustomers();

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(['山田花子', '田中太郎']);
  });
});
