import type { Order } from '../domain/order';
import type { PlaceOrderUseCase, PlaceOrderInput } from '../application/place-order.usecase';
import type { GetOrderUseCase } from '../application/get-order.usecase';
import type { ListOrdersUseCase } from '../application/list-orders.usecase';
import { decodeCursor, encodeCursor } from '@/shared/http/cursor';
import {
  OrderCursorSchema,
  type ListOrdersQuery,
  type ListOrdersResponse,
  type OrderResponse,
} from './order.dto';
import { CustomerNotFoundInOrderError } from '../domain/order.errors';

// Controller の責務:
//   - UseCase を呼び出す（業務手順は知らない）
//   - domain Entity を Response DTO に変換する（VO の中身を外向きの形にほぐす）
//   - HTTP / Hono 固有の API には触れない（routes 層の仕事）
//
// Phase 6 改定:
//   - 入力 customerId を排し、認証済みユーザーの authUserId を受け取る
//   - resolveCustomerId(authUserId) で業務 customer の UUID を取り出す
//   - 解決できないなら NOT_FOUND を投げる（自己復元できない状態）
//
// なぜ controller で解決するのか:
//   「auth と業務 customer の対応付け」は HTTP 層に近い文脈情報の責務。
//   UseCase はあくまで「customerId を持って注文を確定する」という業務に集中させる。
//   結果として UseCase の入出力は Phase 5 と同じ形を維持できる。

export type ResolveCustomerId = (authUserId: string) => Promise<string | null>;

export interface OrderControllerDeps {
  placeOrder: PlaceOrderUseCase;
  getOrder: GetOrderUseCase;
  listOrders: ListOrdersUseCase;
  resolveCustomerId: ResolveCustomerId;
}

const toOrderResponse = (order: Order): OrderResponse => ({
  id: order.id.value,
  customerId: order.customerId.value,
  status: order.status,
  totalAmount: order.totalAmount(),
  placedAt: order.placedAt.toISOString(),
  items: order.items.map((item) => ({
    cakeId: item.cakeId.value,
    quantity: item.quantity.value,
    unitPrice: item.unitPrice,
    subtotal: item.subtotal(),
  })),
});

export const createOrderController = (deps: OrderControllerDeps) => ({
  // POST /v1/orders
  // authUserId は routes 側で c.get('user').id から取り出して渡す。
  place: async (
    authUserId: string,
    input: Omit<PlaceOrderInput, 'customerId'>,
  ): Promise<OrderResponse> => {
    const customerId = await deps.resolveCustomerId(authUserId);
    if (customerId === null) {
      throw new CustomerNotFoundInOrderError(authUserId);
    }
    const order = await deps.placeOrder({ customerId, items: input.items });
    return toOrderResponse(order);
  },

  // GET /v1/orders/:id
  // RLS で本人のみ参照できるため、ここでは特別な認可は行わない（DB が弾く）。
  get: async (id: string): Promise<OrderResponse> => {
    const order = await deps.getOrder({ orderId: id });
    return toOrderResponse(order);
  },

  // GET /v1/orders
  //   authUserId → 業務 customerId を解決し、本人の注文一覧を新しい順で 1 ページ返す。
  //   after（不透明カーソル）をデコード・検証して UseCase に渡し、
  //   返ってきた nextCursor を再エンコードしてレスポンスに載せる。
  //   不正・改竄カーソルは decodeCursor が ValidationError(400) を投げる。
  list: async (authUserId: string, query: ListOrdersQuery): Promise<ListOrdersResponse> => {
    const customerId = await deps.resolveCustomerId(authUserId);
    if (customerId === null) {
      throw new CustomerNotFoundInOrderError(authUserId);
    }
    const after = query.after ? decodeCursor(query.after, OrderCursorSchema) : undefined;
    const page = await deps.listOrders({ customerId, limit: query.limit, after });
    const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;
    return {
      orders: page.orders.map(toOrderResponse),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
    };
  },
});

export type OrderController = ReturnType<typeof createOrderController>;
