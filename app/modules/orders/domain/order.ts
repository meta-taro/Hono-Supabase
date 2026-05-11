import { OrderId } from './order-id.vo';
import { CustomerId } from './customer-id.vo';
import { OrderItem } from './order-item';
import { CakeId } from './cake-id.vo';
import { OrderQuantity } from './order-quantity.vo';
import { type OrderStatus, isOrderStatus } from './order-status';
import { InvalidOrderError } from './order.errors';

const MIN_ITEMS = 1;
// 1 注文の明細上限。業務常識（ケーキ屋の 1 注文）+ DoS 抑止 +
// place_order Postgres Function の処理時間を爆発させない目的。
const MAX_ITEMS = 50;

// Order = 注文（集約根）。
//   - 「商品を 1 件以上 50 件以下」「同じ cakeId は 1 行に統合」など
//     注文構造の不変条件を constructor 経由で守る。
//   - 在庫減算は domain では扱わず、infrastructure 側の place_order Postgres Function に
//     委ねる。理由は CLAUDE.md の方針: アトミック性は DB のトランザクションで担保すべき。
//   - reconstruct() は DB → Aggregate の戻し方を 1 か所に集約する（infrastructure からのみ呼ぶ）。
export class Order {
  private constructor(
    public readonly id: OrderId,
    public readonly customerId: CustomerId,
    public readonly items: readonly OrderItem[],
    public readonly status: OrderStatus,
    public readonly placedAt: Date,
  ) {}

  // 新規作成: 業務ルール（明細数 / 重複 cakeId）を適用する。
  // 主に in-memory リポジトリ + テスト経路で使う。
  // 本番経路は repository.place() → place_order() → reconstruct() を通る。
  static create(input: { customerId: CustomerId; items: OrderItem[] }): Order {
    Order.assertItemsShape(input.items);
    return new Order(OrderId.generate(), input.customerId, [...input.items], 'PLACED', new Date());
  }

  // 永続化層からの復元: DB の値を信頼するが、VO 経由は必ず通すため
  // 壊れた id / status / quantity はここで弾かれる（Fail-Fast）。
  static reconstruct(props: {
    id: string;
    customerId: string;
    items: { cakeId: string; quantity: number; unitPrice: number }[];
    status: string;
    placedAt: Date;
  }): Order {
    if (!isOrderStatus(props.status)) {
      throw new InvalidOrderError(`未知の注文ステータス: ${props.status}`);
    }
    const items = props.items.map((row) =>
      OrderItem.of({
        cakeId: CakeId.from(row.cakeId),
        quantity: OrderQuantity.of(row.quantity),
        unitPrice: row.unitPrice,
      }),
    );
    Order.assertItemsShape(items);
    return new Order(
      OrderId.from(props.id),
      CustomerId.from(props.customerId),
      items,
      props.status,
      props.placedAt,
    );
  }

  // 注文合計金額（円・整数）。集計は Aggregate の責務として domain に置く。
  totalAmount(): number {
    return this.items.reduce((sum, item) => sum + item.subtotal(), 0);
  }

  // 構造的不変条件を 1 か所にまとめる（create / reconstruct の両方から使う）。
  private static assertItemsShape(items: readonly OrderItem[]): void {
    if (items.length < MIN_ITEMS) {
      throw new InvalidOrderError('注文には商品が 1 つ以上必要です');
    }
    if (items.length > MAX_ITEMS) {
      throw new InvalidOrderError(
        `1 注文の明細数は ${String(MAX_ITEMS)} 件以下である必要があります`,
      );
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.cakeId.value)) {
        throw new InvalidOrderError('同一商品は 1 行にまとめて指定してください');
      }
      seen.add(item.cakeId.value);
    }
  }
}
