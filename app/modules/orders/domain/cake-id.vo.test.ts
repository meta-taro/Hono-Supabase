import { describe, it, expect } from 'vitest';
import { CakeId } from './cake-id.vo';
import { InvalidOrderError } from './order.errors';

describe('CakeId.from', () => {
  it('正しい UUID v4 文字列を受け入れる', () => {
    const id = CakeId.from('11111111-1111-4111-8111-111111111111');
    expect(id.value).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('UUID v4 でない文字列は InvalidOrderError を投げる', () => {
    expect(() => CakeId.from('xxx')).toThrow(InvalidOrderError);
  });
});

describe('CakeId.equals', () => {
  it('同値判定が成立する', () => {
    const a = CakeId.from('22222222-2222-4222-8222-222222222222');
    const b = CakeId.from('22222222-2222-4222-8222-222222222222');
    expect(a.equals(b)).toBe(true);
  });
});
