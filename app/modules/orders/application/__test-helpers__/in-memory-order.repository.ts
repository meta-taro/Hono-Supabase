import type {
  ListOrdersByCustomerParams,
  OrderListCursor,
  OrderPage,
  OrderRepository,
  PlaceOrderInput,
} from '../../domain/order.repository';
import { Order } from '../../domain/order';
import { OrderItem } from '../../domain/order-item';
import type { OrderId } from '../../domain/order-id.vo';
import { InsufficientStockError, CakeNotFoundInOrderError } from '../../domain/order.errors';

// 新しい順（placed_at DESC, id DESC）の全順序。Supabase 実装の ORDER BY と揃える。
// placedAt は同値がありうるため id を tiebreaker にする。
const compareNewestFirst = (a: Order, b: Order): number => {
  const at = a.placedAt.getTime();
  const bt = b.placedAt.getTime();
  if (at !== bt) return bt - at; // 新しい（大きい）方が先
  if (a.id.value === b.id.value) return 0;
  return a.id.value < b.id.value ? 1 : -1; // id も降順
};

// キーセット条件 (placedAt, id) < (after.placedAt, after.id)（DESC なので「より過去」を残す）。
const isBefore = (order: Order, after: OrderListCursor): boolean => {
  const op = order.placedAt.toISOString();
  if (op !== after.placedAt) return op < after.placedAt;
  return order.id.value < after.id;
};

// テスト専用のメモリ実装。
// DDD-lite の利点: UseCase を Supabase 抜きで叩ける（高速・決定的）。
// 本番ロジックには絶対に紛れ込ませないため __test-helpers__ ディレクトリに隔離する。
//
// 本番では Postgres Function place_order() が在庫減算 + 注文作成をアトミック実行するが、
// テストでは「同等の業務シミュレーション」を JS で再現する:
//   1. cakes Map で「商品の price と stock」を保持（cakes テーブル相当）
//   2. place() で在庫を確認 → 全 OK なら原子的に減算 + Order を構築
//   3. 1 つでも不足/欠損なら例外を投げ、State は変えない（all-or-nothing）
export interface SeedCake {
  cakeId: string;
  price: number;
  stock: number;
}

// 一覧テスト用に、id / placedAt を指定して注文を直接投入するためのシード。
// place() は Order.create() で id / placedAt を自動採番するため、
// キーセット（placed_at, id）の境界を狙ったテストでは値を固定したい。
export interface SeedOrder {
  id: string;
  customerId: string;
  placedAt: Date;
  items: { cakeId: string; quantity: number; unitPrice: number }[];
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();
  // テストの便宜のため、cakes 状態をこの repo 内に併設する。
  // 本来は別モジュールだが、テストの「全部メモリで動く」性質を活かすため共置。
  private readonly cakes = new Map<string, { price: number; stock: number }>();

  // テストセットアップ用: 商品の在庫と価格を投入する。
  seedCake(seed: SeedCake): void {
    this.cakes.set(seed.cakeId, { price: seed.price, stock: seed.stock });
  }

  // テストアサーション用: 現在の在庫を覗く。
  getStock(cakeId: string): number | undefined {
    return this.cakes.get(cakeId)?.stock;
  }

  // 一覧テスト用: id / placedAt を固定した注文を投入する（在庫には触れない）。
  // reconstruct 経由なので DB からの復元と同じ不変条件チェックを通る。
  seedOrder(seed: SeedOrder): void {
    const order = Order.reconstruct({
      id: seed.id,
      customerId: seed.customerId,
      items: seed.items,
      status: 'PLACED',
      placedAt: seed.placedAt,
    });
    this.orders.set(order.id.value, order);
  }

  async place(input: PlaceOrderInput): Promise<Order> {
    // pass 1: 全件検証（在庫確認・存在確認）。1 つでも不正なら何も変更せずに例外。
    // これにより本番の Postgres Function と同じ「all-or-nothing」セマンティクスを実現する。
    for (const item of input.items) {
      const cake = this.cakes.get(item.cakeId.value);
      if (!cake) {
        throw new CakeNotFoundInOrderError(item.cakeId.value);
      }
      if (cake.stock < item.quantity.value) {
        throw new InsufficientStockError(item.cakeId.value, cake.stock, item.quantity.value);
      }
    }

    // pass 2: 在庫減算 + OrderItem 構築（unitPrice は減算前の price をスナップショット）。
    const orderItems: OrderItem[] = [];
    for (const item of input.items) {
      const cake = this.cakes.get(item.cakeId.value);
      if (!cake) continue; // pass 1 で検証済みのため到達しない
      orderItems.push(
        OrderItem.of({
          cakeId: item.cakeId,
          quantity: item.quantity,
          unitPrice: cake.price,
        }),
      );
      this.cakes.set(item.cakeId.value, {
        price: cake.price,
        stock: cake.stock - item.quantity.value,
      });
    }

    const order = Order.create({
      customerId: input.customerId,
      items: orderItems,
    });
    this.orders.set(order.id.value, order);
    return order;
  }

  async findById(id: OrderId): Promise<Order | null> {
    return this.orders.get(id.value) ?? null;
  }

  async listByCustomer(params: ListOrdersByCustomerParams): Promise<OrderPage> {
    // 1. 本人の注文だけに絞る（RLS 相当の多重防御を JS 側でも再現）。
    const mine = [...this.orders.values()].filter(
      (order) => order.customerId.value === params.customerId.value,
    );

    // 2. 新しい順（placed_at DESC, id DESC）に全順序化。
    mine.sort(compareNewestFirst);

    // 3. after があれば、それより「過去側」だけを残す（キーセット前進）。
    const windowed = params.after
      ? mine.filter((order) => isBefore(order, params.after as OrderListCursor))
      : mine;

    // 4. hasMore 検出のため limit+1 件取り、超過していれば次ページありと判断。
    const candidates = windowed.slice(0, params.limit + 1);
    const hasMore = candidates.length > params.limit;
    const orders = hasMore ? candidates.slice(0, params.limit) : candidates;

    // 5. 次カーソルは「返した最後の 1 件」から生成（hasMore のときのみ）。
    const last = orders[orders.length - 1];
    const nextCursor =
      hasMore && last ? { placedAt: last.placedAt.toISOString(), id: last.id.value } : null;

    return { orders, nextCursor };
  }
}
