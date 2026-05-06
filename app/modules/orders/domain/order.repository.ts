import type { Order } from './order';
import type { OrderId } from './order-id.vo';
import type { CustomerId } from './customer-id.vo';
import type { CakeId } from './cake-id.vo';
import type { OrderQuantity } from './order-quantity.vo';

// 注文確定時に渡す入力（VO レベル）。
// 単価（unit_price）は故意に含めない:
//   - 単価は「DB で在庫行をロックした瞬間の cakes.price」をスナップショットする
//   - クライアント側で価格を渡す経路を作ると、価格改竄の温床になる
//   - 結果として、UseCase / 上位層は価格を意識しない
export interface PlaceOrderItem {
  cakeId: CakeId;
  quantity: OrderQuantity;
}

export interface PlaceOrderInput {
  customerId: CustomerId;
  items: PlaceOrderItem[];
}

// 永続化の interface は domain で定義する。
// 具体実装（Supabase / InMemory）は infrastructure / __test-helpers__ に置く。
//
// CakeRepository / CustomerRepository が save(entity) を持っていたのと違い、
// OrderRepository は place(input) を採用している。理由:
//   - 注文の確定は「在庫減算 + 注文挿入 + 明細挿入」のトランザクションが本質
//   - その原子性を application 層から表現するのは無理（DB の責務）
//   - だから「注文する」という業務動詞そのものを repository の入口にする
export interface OrderRepository {
  place(input: PlaceOrderInput): Promise<Order>;
  findById(id: OrderId): Promise<Order | null>;
}
