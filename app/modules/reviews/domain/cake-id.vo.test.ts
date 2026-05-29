import { describe, expect, it } from 'vitest';
import { CakeId } from './cake-id.vo';
import { InvalidReviewError } from './review.errors';

describe('reviews/CakeId (context-local copy)', () => {
  it('from() で UUID v4 文字列を VO 化できる', () => {
    const valid = '11111111-2222-4333-8444-555555555555';
    expect(CakeId.from(valid).value).toBe(valid);
  });

  it('from() は UUID v4 でない値を InvalidReviewError で弾く', () => {
    // reviews コンテキストの CakeId は cakes コンテキストの CakeId とは別物。
    // 例外型は reviews 側の InvalidReviewError でなければならない（コンテキスト跨ぎ禁止）。
    expect(() => CakeId.from('not-a-uuid')).toThrow(InvalidReviewError);
  });

  it('equals() は value 比較で同値判定する', () => {
    const a = CakeId.from('11111111-2222-4333-8444-555555555555');
    const b = CakeId.from('11111111-2222-4333-8444-555555555555');
    const c = CakeId.from('99999999-2222-4333-8444-555555555555');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});
