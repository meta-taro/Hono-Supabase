import { describe, it, expect } from 'vitest';
import { CustomerId } from './customer-id.vo';
import { InvalidOrderError } from './order.errors';

describe('CustomerId.from', () => {
  it('正しい UUID v4 文字列を受け入れる', () => {
    const id = CustomerId.from('11111111-1111-4111-8111-111111111111');
    expect(id.value).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('UUID v4 でない文字列は InvalidOrderError を投げる', () => {
    expect(() => CustomerId.from('not-a-uuid')).toThrow(InvalidOrderError);
  });
});

describe('CustomerId.equals', () => {
  it('同じ値なら true、異なれば false', () => {
    const a = CustomerId.from('22222222-2222-4222-8222-222222222222');
    const b = CustomerId.from('22222222-2222-4222-8222-222222222222');
    const c = CustomerId.from('33333333-3333-4333-8333-333333333333');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});
