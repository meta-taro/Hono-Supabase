import type { OrderRepository, PlaceOrderInput } from '../../domain/order.repository';
import { Order } from '../../domain/order';
import { OrderItem } from '../../domain/order-item';
import type { OrderId } from '../../domain/order-id.vo';
import { InsufficientStockError, CakeNotFoundInOrderError } from '../../domain/order.errors';

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
}
