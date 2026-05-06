import type { Order } from '../domain/order';
import type {
  PlaceOrderUseCase,
  PlaceOrderInput,
} from '../application/place-order.usecase';
import type { GetOrderUseCase } from '../application/get-order.usecase';
import type { OrderResponse } from './order.dto';

// Controller の責務:
//   - UseCase を呼び出す（業務手順は知らない）
//   - domain Entity を Response DTO に変換する（VO の中身を外向きの形にほぐす）
//   - HTTP / Hono 固有の API には触れない（routes 層の仕事）

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

export interface OrderControllerDeps {
  placeOrder: PlaceOrderUseCase;
  getOrder: GetOrderUseCase;
}

export const createOrderController = (deps: OrderControllerDeps) => ({
  // POST /v1/orders
  // 入力は routes 側で Zod により検証済み。ここでは UseCase に流すだけ。
  place: async (input: PlaceOrderInput): Promise<OrderResponse> => {
    const order = await deps.placeOrder(input);
    return toOrderResponse(order);
  },

  // GET /v1/orders/:id
  get: async (id: string): Promise<OrderResponse> => {
    const order = await deps.getOrder({ orderId: id });
    return toOrderResponse(order);
  },
});

export type OrderController = ReturnType<typeof createOrderController>;
