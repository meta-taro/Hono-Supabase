import type { OrderRepository } from '../domain/order.repository';
import type { Order } from '../domain/order';
import { OrderId } from '../domain/order-id.vo';
import { OrderNotFoundError } from '../domain/order.errors';

export interface GetOrderInput {
  orderId: string;
}

// 業務手順:
//   1. 入力 orderId を VO 化（UUID 形式違反はここで InvalidOrderError）
//   2. repository.findById で取得
//   3. 見つからなければ OrderNotFoundError（404 へマッピング）
//
// Phase 6 では「本人のみ参照可能」の認可チェックをここに追加する予定。
// 現状は無認証 / 全員参照可能（学習段階）。
export const createGetOrderUseCase = (repo: OrderRepository) => {
  return async (input: GetOrderInput): Promise<Order> => {
    const orderId = OrderId.from(input.orderId);
    const order = await repo.findById(orderId);
    if (order === null) {
      throw new OrderNotFoundError(orderId.value);
    }
    return order;
  };
};

export type GetOrderUseCase = ReturnType<typeof createGetOrderUseCase>;
