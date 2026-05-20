import { CustomerId } from '../domain/customer-id.vo';
import type { OrderListCursor, OrderPage, OrderRepository } from '../domain/order.repository';

// 一覧の入力。customerId は string（controller が resolveCustomerId で解決した業務 ID）で受け、
// ここで VO 化する。after はデコード済みカーソル（presentation 層で検証済み）。
export interface ListOrdersInput {
  customerId: string;
  limit: number;
  after?: OrderListCursor;
}

// UseCase = 本人の注文一覧を新しい順で 1 ページ返す。
// キーセット計算は Repository（永続化の都合を知る層）に委ね、ここは薄く保つ。
export const createListOrdersUseCase = (repo: OrderRepository) => {
  return async (input: ListOrdersInput): Promise<OrderPage> => {
    return repo.listByCustomer({
      customerId: CustomerId.from(input.customerId),
      limit: input.limit,
      after: input.after,
    });
  };
};

export type ListOrdersUseCase = ReturnType<typeof createListOrdersUseCase>;
