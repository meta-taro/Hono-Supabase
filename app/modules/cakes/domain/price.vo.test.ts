import { describe, it, expect } from 'vitest';
import { Price } from './price.vo';
import { InvalidPriceError } from './cake.errors';

describe('Price.of', () => {
  it('正の整数を受け入れる', () => {
    expect(Price.of(1).value).toBe(1);
    expect(Price.of(600).value).toBe(600);
    expect(Price.of(1_000_000).value).toBe(1_000_000);
  });

  it('0 を拒否する', () => {
    expect(() => Price.of(0)).toThrow(InvalidPriceError);
  });

  it('負の値を拒否する', () => {
    expect(() => Price.of(-1)).toThrow(InvalidPriceError);
  });

  it('小数を拒否する', () => {
    expect(() => Price.of(599.99)).toThrow(InvalidPriceError);
  });

  it('上限超過（1,000,001）を拒否する', () => {
    expect(() => Price.of(1_000_001)).toThrow(InvalidPriceError);
  });

  it('NaN を拒否する', () => {
    expect(() => Price.of(NaN)).toThrow(InvalidPriceError);
  });

  it('Infinity を拒否する', () => {
    expect(() => Price.of(Infinity)).toThrow(InvalidPriceError);
  });
});

describe('Price.equals', () => {
  it('同じ value なら true', () => {
    expect(Price.of(600).equals(Price.of(600))).toBe(true);
  });

  it('違う value なら false', () => {
    expect(Price.of(600).equals(Price.of(700))).toBe(false);
  });
});
