import { describe, it, expect } from 'vitest';
import { CustomerId } from './customer-id.vo';
import { InvalidCustomerError } from './customer.errors';

describe('CustomerId.generate', () => {
  it('UUID v4 形式の値を生成する', () => {
    const id = CustomerId.generate();
    expect(id.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('呼び出すたびに異なる ID を返す', () => {
    expect(CustomerId.generate().value).not.toBe(CustomerId.generate().value);
  });
});

describe('CustomerId.from', () => {
  it('有効な UUID v4 を受け入れる', () => {
    const value = '550e8400-e29b-41d4-a716-446655440000';
    expect(CustomerId.from(value).value).toBe(value);
  });

  it('UUID 以外の文字列を拒否する', () => {
    expect(() => CustomerId.from('not-uuid')).toThrow(InvalidCustomerError);
  });

  it('UUID v1 形式（バージョン桁が 1）を拒否する', () => {
    expect(() => CustomerId.from('550e8400-e29b-11d4-a716-446655440000')).toThrow(
      InvalidCustomerError,
    );
  });

  it('空文字を拒否する', () => {
    expect(() => CustomerId.from('')).toThrow(InvalidCustomerError);
  });
});

describe('CustomerId.equals', () => {
  it('同じ value なら true', () => {
    const v = '550e8400-e29b-41d4-a716-446655440000';
    expect(CustomerId.from(v).equals(CustomerId.from(v))).toBe(true);
  });

  it('違う value なら false', () => {
    expect(CustomerId.generate().equals(CustomerId.generate())).toBe(false);
  });
});
