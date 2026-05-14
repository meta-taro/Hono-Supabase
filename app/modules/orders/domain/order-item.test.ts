import { describe, it, expect } from 'vitest';
import { CakeId } from './cake-id.vo';
import { OrderItem } from './order-item';
import { OrderQuantity } from './order-quantity.vo';
import { InvalidOrderItemError } from './order.errors';

const cakeId = () => CakeId.from('11111111-1111-4111-8111-111111111111');
const quantity = (n: number) => OrderQuantity.of(n);

describe('OrderItem.of', () => {
  it('正常な値で生成できる', () => {
    const item = OrderItem.of({
      cakeId: cakeId(),
      quantity: quantity(3),
      unitPrice: 500,
    });
    expect(item.cakeId.value).toBe('11111111-1111-4111-8111-111111111111');
    expect(item.quantity.value).toBe(3);
    expect(item.unitPrice).toBe(500);
  });

  it.each([
    ['小数', 1.5],
    ['ゼロ', 0],
    ['負数', -100],
    ['上限超過', 1_000_001],
  ])('単価 %s (%s) は InvalidOrderItemError を投げる', (_label, price) => {
    expect(() =>
      OrderItem.of({ cakeId: cakeId(), quantity: quantity(1), unitPrice: price }),
    ).toThrow(InvalidOrderItemError);
  });
});

describe('OrderItem.subtotal', () => {
  it('単価 × 数量を返す', () => {
    const item = OrderItem.of({
      cakeId: cakeId(),
      quantity: quantity(4),
      unitPrice: 250,
    });
    expect(item.subtotal()).toBe(1000);
  });

  it('上限ペアでもオーバーフローしない（100 × 1,000,000 = 1e8）', () => {
    const item = OrderItem.of({
      cakeId: cakeId(),
      quantity: quantity(100),
      unitPrice: 1_000_000,
    });
    expect(item.subtotal()).toBe(100_000_000);
    expect(Number.isSafeInteger(item.subtotal())).toBe(true);
  });
});
