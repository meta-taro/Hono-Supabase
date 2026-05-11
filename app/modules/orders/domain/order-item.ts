import { CakeId } from './cake-id.vo';
import { OrderQuantity } from './order-quantity.vo';
import { InvalidOrderItemError } from './order.errors';

const MIN_UNIT_PRICE = 1;
const MAX_UNIT_PRICE = 1_000_000;

// OrderItem は Order Aggregate の一部の Value Object。
//   - 個別の業務 ID（外部から参照される）を持たない（DB 上の order_items.id は内部都合）
//   - 不変オブジェクトとして扱う（変更したい場合は新インスタンスを作る）
//
// なぜ unitPrice を Cake から「コピー」して保持するのか:
//   - 注文時点の単価を不変に固定するため（Cake.price は将来変わる可能性がある）
//   - これを「価格スナップショット」と呼ぶ。EC / 受発注系のドメインで定石
//   - cakes コンテキストの Price VO を import するのは禁則（コンテキスト分離）。
//     ここでは生 number に対する境界検証（1〜1,000,000）を直接持たせる。
export class OrderItem {
  private constructor(
    public readonly cakeId: CakeId,
    public readonly quantity: OrderQuantity,
    public readonly unitPrice: number,
  ) {}

  static of(input: { cakeId: CakeId; quantity: OrderQuantity; unitPrice: number }): OrderItem {
    if (!Number.isInteger(input.unitPrice)) {
      throw new InvalidOrderItemError('単価は整数である必要があります');
    }
    if (input.unitPrice < MIN_UNIT_PRICE) {
      throw new InvalidOrderItemError(`単価は ${String(MIN_UNIT_PRICE)} 以上である必要があります`);
    }
    if (input.unitPrice > MAX_UNIT_PRICE) {
      throw new InvalidOrderItemError(
        `単価は ${MAX_UNIT_PRICE.toLocaleString()} 以下である必要があります`,
      );
    }
    return new OrderItem(input.cakeId, input.quantity, input.unitPrice);
  }

  // 小計 = 単価 × 数量。整数演算なので JS の安全整数範囲内に収まる
  // （MAX_UNIT_PRICE × MAX_QUANTITY = 1e8、Order 全体合算でも安全）。
  subtotal(): number {
    return this.unitPrice * this.quantity.value;
  }
}
