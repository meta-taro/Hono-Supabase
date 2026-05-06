import { describe, it, expect } from 'vitest';
import { OrderId } from './order-id.vo';
import { InvalidOrderError } from './order.errors';

describe('OrderId.generate', () => {
  it('UUID v4 形式の ID を生成する', () => {
    const id = OrderId.generate();
    expect(id.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('呼び出すたび異なる ID を生成する', () => {
    const a = OrderId.generate();
    const b = OrderId.generate();
    expect(a.equals(b)).toBe(false);
  });
});

describe('OrderId.from', () => {
  it('正しい UUID v4 文字列を受け入れる', () => {
    const id = OrderId.from('11111111-1111-4111-8111-111111111111');
    expect(id.value).toBe('11111111-1111-4111-8111-111111111111');
  });

  it.each([
    ['空文字', ''],
    ['UUID v1', '11111111-1111-1111-8111-111111111111'],
    ['形式不正', 'not-a-uuid'],
    ['長すぎ', '11111111-1111-4111-8111-1111111111111'],
  ])('%s は InvalidOrderError を投げる', (_label, value) => {
    expect(() => OrderId.from(value)).toThrow(InvalidOrderError);
  });
});

describe('OrderId.equals', () => {
  it('同じ値なら true', () => {
    const a = OrderId.from('22222222-2222-4222-8222-222222222222');
    const b = OrderId.from('22222222-2222-4222-8222-222222222222');
    expect(a.equals(b)).toBe(true);
  });

  it('異なる値なら false', () => {
    const a = OrderId.from('22222222-2222-4222-8222-222222222222');
    const b = OrderId.from('33333333-3333-4333-8333-333333333333');
    expect(a.equals(b)).toBe(false);
  });
});
