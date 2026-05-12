import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { Order } from '@/modules/orders/domain/order';
import type { OrderRepository, PlaceOrderInput } from '@/modules/orders/domain/order.repository';
import { OrderId } from '@/modules/orders/domain/order-id.vo';
import {
  CakeNotFoundInOrderError,
  CustomerNotFoundInOrderError,
  InsufficientStockError,
  InvalidOrderError,
} from '@/modules/orders/domain/order.errors';

// DB 行の型。domain の Order / OrderItem と独立させる。
// nested select の結果を表現するため、order_items は配列として埋め込まれる。
interface OrderItemRow {
  cake_id: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  total_amount: number;
  placed_at: string; // timestamptz は ISO 文字列で来る
  order_items: OrderItemRow[];
}

const TABLE_NAME = 'orders';
const SELECT_WITH_ITEMS = `
  id,
  customer_id,
  status,
  total_amount,
  placed_at,
  order_items (
    cake_id,
    quantity,
    unit_price,
    subtotal
  )
`;

// PostgREST が「結果 0 件 + .single()」のときに返すコード。
const PGRST_NO_ROWS = 'PGRST116';

export class OrderSupabaseRepository implements OrderRepository {
  // SupabaseClient は composition-root で anon / admin を選んで注入する。
  constructor(private readonly sb: SupabaseClient) {}

  async place(input: PlaceOrderInput): Promise<Order> {
    // Postgres Function place_order(p_customer_id, p_items) を RPC で呼ぶ。
    // この関数内で「在庫減算 + 注文挿入 + 明細挿入」が 1 トランザクションでアトミックに実行される。
    // 型付き Supabase スキーマを生成していないので rpc() の戻り値は any。
    // unknown に絞り込み、下の typeof チェックで string に確定させる。
    const { data: orderId, error } = (await this.sb.rpc('place_order', {
      p_customer_id: input.customerId.value,
      p_items: input.items.map((i) => ({
        cake_id: i.cakeId.value,
        quantity: i.quantity.value,
      })),
    })) as { data: unknown; error: PostgrestError | null };

    if (error) {
      this.translatePlaceOrderError(error);
      // translatePlaceOrderError がドメイン例外を throw しなかった場合は内部エラー扱い
      throw new Error(`place_order RPC が失敗しました: ${error.message}`);
    }

    if (typeof orderId !== 'string') {
      throw new Error(`place_order RPC が想定外の戻り値を返しました: ${JSON.stringify(orderId)}`);
    }

    // 確定済みの注文を読み戻して domain の Order として返す。
    // place_order の中で行が確実に作られているはずなので、null は内部エラー扱い。
    const placed = await this.findById(OrderId.from(orderId));
    if (placed === null) {
      throw new Error(`place_order が id=${orderId} を返したが、読み戻しで見つかりません`);
    }
    return placed;
  }

  async findById(id: OrderId): Promise<Order | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(SELECT_WITH_ITEMS)
      .eq('id', id.value)
      .maybeSingle<OrderRow>();

    if (error && error.code !== PGRST_NO_ROWS) {
      throw new Error(`Order の取得に失敗しました: ${error.message}`);
    }
    if (data === null) {
      return null;
    }

    return Order.reconstruct({
      id: data.id,
      customerId: data.customer_id,
      status: data.status,
      placedAt: new Date(data.placed_at),
      items: data.order_items.map((row) => ({
        cakeId: row.cake_id,
        quantity: row.quantity,
        unitPrice: row.unit_price,
      })),
    });
  }

  // place_order の RAISE EXCEPTION をドメイン例外にマッピングする。
  // application 層は Postgres を知らずに適切な HTTP ステータス（404 / 409 / 400）を返せる。
  //
  // 識別方法:
  //   - errcode = 'P0003' は本プロジェクト独自に「在庫不足」として割り当てた
  //   - errcode = 'P0002' は「対象なし」（顧客 / 商品の不在）
  //   - メッセージのプレフィクス（INSUFFICIENT_STOCK / CAKE_NOT_FOUND / ...）で判別する
  private translatePlaceOrderError(error: PostgrestError): void {
    const message = error.message;

    if (message.startsWith('INSUFFICIENT_STOCK')) {
      // 形式: 'INSUFFICIENT_STOCK cake_id=<uuid> available=<n> requested=<n>'
      const match = message.match(/cake_id=([0-9a-f-]{36}) available=(\d+) requested=(\d+)/i);
      if (match) {
        throw new InsufficientStockError(
          match[1] ?? '',
          parseInt(match[2] ?? '0', 10),
          parseInt(match[3] ?? '0', 10),
        );
      }
      // パターンに合わない場合もダムに 409 を返す（業務上の在庫不足には変わりない）
      throw new InsufficientStockError('unknown', 0, 0);
    }

    if (message.startsWith('CAKE_NOT_FOUND')) {
      const match = message.match(/CAKE_NOT_FOUND ([0-9a-f-]{36})/i);
      throw new CakeNotFoundInOrderError(match?.[1] ?? 'unknown');
    }

    if (message.startsWith('CUSTOMER_NOT_FOUND')) {
      const match = message.match(/CUSTOMER_NOT_FOUND ([0-9a-f-]{36})/i);
      throw new CustomerNotFoundInOrderError(match?.[1] ?? 'unknown');
    }

    if (message.startsWith('EMPTY_ITEMS')) {
      throw new InvalidOrderError('注文には商品が 1 つ以上必要です');
    }

    // 上記以外は呼び元で内部エラーとして扱う（throw しない）
  }
}
