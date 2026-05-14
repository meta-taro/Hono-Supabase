import { describe, it, expect } from 'vitest';
import { CakeId } from './cake-id.vo';
import { InvalidCakeError } from './cake.errors';

describe('CakeId.generate', () => {
  it('UUID v4 形式の値を生成する', () => {
    const id = CakeId.generate();
    expect(id.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('呼び出すたびに異なる ID を返す', () => {
    expect(CakeId.generate().value).not.toBe(CakeId.generate().value);
  });
});

describe('CakeId.from', () => {
  it('有効な UUID v4 を受け入れる', () => {
    const value = '550e8400-e29b-41d4-a716-446655440000';
    expect(CakeId.from(value).value).toBe(value);
  });

  it('UUID 以外の文字列を拒否する', () => {
    expect(() => CakeId.from('not-uuid')).toThrow(InvalidCakeError);
  });

  it('UUID v1 形式（バージョン桁が 1）を拒否する', () => {
    expect(() => CakeId.from('550e8400-e29b-11d4-a716-446655440000')).toThrow(InvalidCakeError);
  });

  it('空文字を拒否する', () => {
    expect(() => CakeId.from('')).toThrow(InvalidCakeError);
  });
});

describe('CakeId.equals', () => {
  it('同じ value なら true', () => {
    const v = '550e8400-e29b-41d4-a716-446655440000';
    expect(CakeId.from(v).equals(CakeId.from(v))).toBe(true);
  });

  it('違う value なら false', () => {
    expect(CakeId.generate().equals(CakeId.generate())).toBe(false);
  });
});
