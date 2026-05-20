import type { Order } from './order';
import type { OrderId } from './order-id.vo';
import type { CustomerId } from './customer-id.vo';
import type { CakeId } from './cake-id.vo';
import type { OrderQuantity } from './order-quantity.vo';

// 注文一覧のカーソル（キーセットページネーション用）。
// placed_at は同時刻の注文がありうる非一意キーのため、id を tiebreaker に複合化する。
// placedAt は ISO 8601 UTC 文字列で保持する（辞書順 = 時系列順になり比較が単純）。
export interface OrderListCursor {
  placedAt: string;
  id: string;
}

// 本人（customerId）の注文を新しい順（placed_at DESC, id DESC）で 1 ページ取得する。
// after を起点に limit 件返す。after 省略で先頭ページ。
export interface ListOrdersByCustomerParams {
  customerId: CustomerId;
  limit: number;
  after?: OrderListCursor;
}

// 1 ページ分の結果。nextCursor が null なら以降のページは無い。
export interface OrderPage {
  orders: Order[];
  nextCursor: OrderListCursor | null;
}

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
  // 本人の注文一覧（新しい順）。RLS でも本人に絞られるが、
  // 多重防御 + in-memory テスタビリティのため customerId を明示的に受け取る。
  listByCustomer(params: ListOrdersByCustomerParams): Promise<OrderPage>;
}
