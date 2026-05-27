import { describe, expect, it } from 'vitest';
import { Rating } from './rating.vo';
import { InvalidRatingError } from './review.errors';

describe('Rating', () => {
  it.each([1, 2, 3, 4, 5])('1〜5 の整数 %i を受け付ける', (n) => {
    expect(Rating.of(n).value).toBe(n);
  });

  it('範囲外の整数を InvalidRatingError で弾く', () => {
    expect(() => Rating.of(0)).toThrow(InvalidRatingError);
    expect(() => Rating.of(6)).toThrow(InvalidRatingError);
    expect(() => Rating.of(-1)).toThrow(InvalidRatingError);
  });

  it('小数を InvalidRatingError で弾く（0.5 刻みは Phase 11 では非対応）', () => {
    expect(() => Rating.of(3.5)).toThrow(InvalidRatingError);
    expect(() => Rating.of(4.1)).toThrow(InvalidRatingError);
  });

  it('NaN / Infinity を弾く', () => {
    expect(() => Rating.of(Number.NaN)).toThrow(InvalidRatingError);
    expect(() => Rating.of(Number.POSITIVE_INFINITY)).toThrow(InvalidRatingError);
  });

  it('equals() は value 比較で同値判定する', () => {
    expect(Rating.of(4).equals(Rating.of(4))).toBe(true);
    expect(Rating.of(4).equals(Rating.of(5))).toBe(false);
  });
});
