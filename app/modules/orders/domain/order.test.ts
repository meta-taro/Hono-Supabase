import { describe, it, expect } from 'vitest';
import { Order } from './order';
import { OrderItem } from './order-item';
import { OrderId } from './order-id.vo';
import { CustomerId } from './customer-id.vo';
import { CakeId } from './cake-id.vo';
import { OrderQuantity } from './order-quantity.vo';
import { InvalidOrderError } from './order.errors';

const customerId = () =>
  CustomerId.from('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

const itemFor = (cakeIdStr: string, qty: number, unit: number): OrderItem =>
  OrderItem.of({
    cakeId: CakeId.from(cakeIdStr),
    quantity: OrderQuantity.of(qty),
    unitPrice: unit,
  });

describe('Order.create', () => {
  it('1 件の明細で注文を生成できる（status=PLACED, id 自動採番）', () => {
    const item = itemFor('11111111-1111-4111-8111-111111111111', 2, 500);
    const order = Order.create({ customerId: customerId(), items: [item] });

    expect(order.id).toBeInstanceOf(OrderId);
    expect(order.customerId.equals(customerId())).toBe(true);
    expect(order.status).toBe('PLACED');
    expect(order.items).toHaveLength(1);
    expect(order.placedAt).toBeInstanceOf(Date);
  });

  it('複数明細の合計金額を返す', () => {
    const a = itemFor('11111111-1111-4111-8111-111111111111', 2, 500); // 1000
    const b = itemFor('22222222-2222-4222-8222-222222222222', 1, 750); // 750
    const order = Order.create({ customerId: customerId(), items: [a, b] });
    expect(order.totalAmount()).toBe(1750);
  });

  it('items が 0 件のときは InvalidOrderError', () => {
    expect(() =>
      Order.create({ customerId: customerId(), items: [] }),
    ).toThrow(InvalidOrderError);
  });

  it('明細数が 50 件を超えるときは InvalidOrderError', () => {
    const items: OrderItem[] = [];
    // 51 件: 異なる cake_id を持たせる必要があるので indexed UUID を使う
    for (let i = 0; i < 51; i++) {
      const hex = i.toString(16).padStart(2, '0');
      items.push(
        itemFor(`${hex}${hex}${hex}${hex}-1111-4111-8111-111111111111`, 1, 100),
      );
    }
    expect(() =>
      Order.create({ customerId: customerId(), items }),
    ).toThrow(InvalidOrderError);
  });

  it('同じ cakeId が 2 行に分かれている入力は InvalidOrderError', () => {
    const dup = '11111111-1111-4111-8111-111111111111';
    const a = itemFor(dup, 1, 500);
    const b = itemFor(dup, 2, 500);
    expect(() =>
      Order.create({ customerId: customerId(), items: [a, b] }),
    ).toThrow(InvalidOrderError);
  });

  it('items 配列はコピーされる（外部破壊の影響を受けない）', () => {
    const item = itemFor('11111111-1111-4111-8111-111111111111', 1, 500);
    const items = [item];
    const order = Order.create({ customerId: customerId(), items });
    items.push(itemFor('22222222-2222-4222-8222-222222222222', 1, 500));
    expect(order.items).toHaveLength(1);
  });
});

describe('Order.reconstruct', () => {
  const validProps = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    items: [
      {
        cakeId: '11111111-1111-4111-8111-111111111111',
        quantity: 3,
        unitPrice: 500,
      },
    ],
    status: 'PLACED' as const,
    placedAt: new Date('2026-05-06T10:00:00Z'),
  };

  it('DB 由来のプリミティブから Order を復元する', () => {
    const order = Order.reconstruct(validProps);
    expect(order.id.value).toBe(validProps.id);
    expect(order.totalAmount()).toBe(1500);
    expect(order.status).toBe('PLACED');
  });

  it('未知の status は InvalidOrderError', () => {
    expect(() =>
      Order.reconstruct({ ...validProps, status: 'BOGUS' }),
    ).toThrow(InvalidOrderError);
  });

  it('items 0 件は InvalidOrderError（DB 整合性破綻の検知）', () => {
    expect(() =>
      Order.reconstruct({ ...validProps, items: [] }),
    ).toThrow(InvalidOrderError);
  });
});
