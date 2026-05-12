import { describe, it, expect } from 'vitest';
import { Order } from './order';
import { OrderItem } from './order-item';
import { CustomerId } from './customer-id.vo';
import { CakeId } from './cake-id.vo';
import { OrderQuantity } from './order-quantity.vo';
import { orderPlacedEvent } from './order-placed.event';

describe('orderPlacedEvent', () => {
  it('Order から OrderPlaced イベント形を生成する', () => {
    const order = Order.create({
      customerId: CustomerId.from('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      items: [
        OrderItem.of({
          cakeId: CakeId.from('11111111-1111-4111-8111-111111111111'),
          quantity: OrderQuantity.of(2),
          unitPrice: 600,
        }),
      ],
    });

    const event = orderPlacedEvent(order);

    expect(event.type).toBe('OrderPlaced');
    expect(event.orderId).toBe(order.id.value);
    expect(event.customerId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(event.totalAmount).toBe(1200);
    expect(event.itemCount).toBe(1);
    // ISO 8601 UTC 形式（Z 終わり）
    expect(event.placedAt).toMatch(/Z$/);
  });
});
