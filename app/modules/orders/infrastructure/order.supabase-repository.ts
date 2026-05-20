import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { Order } from '@/modules/orders/domain/order';
import type {
  ListOrdersByCustomerParams,
  OrderPage,
  OrderRepository,
  PlaceOrderInput,
} from '@/modules/orders/domain/order.repository';
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

// PostgREST のフィルタ値（タイムスタンプ・UUID）に予約文字が混ざっても
// `or(...)` の構文を壊さないよう、ダブルクォートで囲んで \ と " をエスケープする。
// （cakes 実装と同じ防御。値は PostgREST 側で SQL にバインドされるため
//   インジェクションは起きないが、引用しないとフィルタ式が壊れて 400 になる。）
const pgrstQuoteValue = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

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

    return this.toOrder(data);
  }

  async listByCustomer(params: ListOrdersByCustomerParams): Promise<OrderPage> {
    // customer_id を明示的に絞り込む（多重防御）。RLS でも本人に絞られるが、
    // service_role クライアントが注入された経路でも漏れないよう repository でも絞る。
    const base = this.sb
      .from(TABLE_NAME)
      .select(SELECT_WITH_ITEMS)
      .eq('customer_id', params.customerId.value);

    // キーセット法（新しい順 placed_at DESC, id DESC）。
    //   placed_at.lt.X            … X より過去の行
    //   and(placed_at.eq.X, id.lt.Y) … 同時刻なら id で先に進む（取りこぼし防止）
    const filtered = params.after
      ? base.or(
          `placed_at.lt.${pgrstQuoteValue(params.after.placedAt)},` +
            `and(placed_at.eq.${pgrstQuoteValue(params.after.placedAt)},id.lt.${pgrstQuoteValue(params.after.id)})`,
        )
      : base;

    // limit + 1 件取得し、超過分があれば「次ページあり」と判定する。
    // ORDER BY はキーセット条件と同じ並び（placed_at DESC, id DESC）でなければ整合しない。
    const { data, error } = await filtered
      .order('placed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(params.limit + 1)
      .overrideTypes<OrderRow[], { merge: false }>();

    if (error) {
      throw new Error(`Order 一覧の取得に失敗しました: ${error.message}`);
    }

    const hasMore = data.length > params.limit;
    const rows = hasMore ? data.slice(0, params.limit) : data;
    const orders = rows.map((row) => this.toOrder(row));

    const last = orders[orders.length - 1];
    const nextCursor =
      hasMore && last ? { placedAt: last.placedAt.toISOString(), id: last.id.value } : null;

    return { orders, nextCursor };
  }

  // OrderRow（nested select 結果）→ domain の Order へ復元する。
  // 復元は必ず reconstruct 経由で、DB 由来データにも不変条件を適用する。
  private toOrder(row: OrderRow): Order {
    return Order.reconstruct({
      id: row.id,
      customerId: row.customer_id,
      status: row.status,
      placedAt: new Date(row.placed_at),
      items: row.order_items.map((item) => ({
        cakeId: item.cake_id,
        quantity: item.quantity,
        unitPrice: item.unit_price,
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
