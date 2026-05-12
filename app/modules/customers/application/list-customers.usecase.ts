import type { Customer } from '../domain/customer';
import type { CustomerRepository } from '../domain/customer.repository';

// UseCase = アプリケーションサービス。業務手順を 1 つだけ持つ。
// ファクトリ関数で Repository を受け取る（手動 DI）。
// クラスにせず関数で公開するのは、テストでモック差し替えがしやすいため。
export const createListCustomersUseCase = (repo: CustomerRepository) => {
  return async (): Promise<Customer[]> => {
    return repo.list();
  };
};

export type ListCustomersUseCase = ReturnType<typeof createListCustomersUseCase>;
