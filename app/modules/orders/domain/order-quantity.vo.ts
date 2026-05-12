import { InvalidOrderItemError } from './order.errors';

const MIN_QUANTITY = 1;
// 1 注文 1 商品あたりの数量上限。業務常識（ケーキ屋で 1 種類を 100 個も買わない）+
// 整数オーバーフロー防止 + DoS 抑止の意味で設けている。
const MAX_QUANTITY = 100;

// 注文明細の数量を表す VO。
// 「正の整数（1 以上 100 以下）」という不変条件を OrderItem の外で守るために切り出している。
export class OrderQuantity {
  private constructor(public readonly value: number) {}

  static of(value: number): OrderQuantity {
    if (!Number.isInteger(value)) {
      throw new InvalidOrderItemError('数量は整数である必要があります');
    }
    if (value < MIN_QUANTITY) {
      throw new InvalidOrderItemError(`数量は ${String(MIN_QUANTITY)} 以上である必要があります`);
    }
    if (value > MAX_QUANTITY) {
      throw new InvalidOrderItemError(`数量は ${String(MAX_QUANTITY)} 以下である必要があります`);
    }
    return new OrderQuantity(value);
  }

  equals(other: OrderQuantity): boolean {
    return this.value === other.value;
  }
}
