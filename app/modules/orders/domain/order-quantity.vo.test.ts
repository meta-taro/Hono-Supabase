import { describe, it, expect } from 'vitest';
import { OrderQuantity } from './order-quantity.vo';
import { InvalidOrderItemError } from './order.errors';

describe('OrderQuantity.of', () => {
  it.each([1, 2, 50, 100])('%i を受け入れる', (n) => {
    expect(OrderQuantity.of(n).value).toBe(n);
  });

  it.each([
    ['0', 0],
    ['負数', -1],
    ['上限超過', 101],
  ])('%s (%i) は InvalidOrderItemError を投げる', (_label, n) => {
    expect(() => OrderQuantity.of(n)).toThrow(InvalidOrderItemError);
  });

  it('小数は弾く', () => {
    expect(() => OrderQuantity.of(1.5)).toThrow(InvalidOrderItemError);
  });

  it('NaN / Infinity は弾く', () => {
    expect(() => OrderQuantity.of(NaN)).toThrow(InvalidOrderItemError);
    expect(() => OrderQuantity.of(Infinity)).toThrow(InvalidOrderItemError);
  });
});

describe('OrderQuantity.equals', () => {
  it('同値判定が成立する', () => {
    expect(OrderQuantity.of(3).equals(OrderQuantity.of(3))).toBe(true);
    expect(OrderQuantity.of(3).equals(OrderQuantity.of(4))).toBe(false);
  });
});
