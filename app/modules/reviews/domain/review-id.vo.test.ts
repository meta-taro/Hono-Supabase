import { describe, expect, it } from 'vitest';
import { ReviewId } from './review-id.vo';
import { InvalidReviewError } from './review.errors';

describe('ReviewId', () => {
  it('generate() で UUID v4 を発行できる', () => {
    const id = ReviewId.generate();
    expect(id.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('from() で UUID v4 文字列を VO 化できる', () => {
    const valid = '11111111-2222-4333-8444-555555555555';
    expect(ReviewId.from(valid).value).toBe(valid);
  });

  it('from() は UUID v4 でない値を InvalidReviewError で弾く', () => {
    expect(() => ReviewId.from('not-a-uuid')).toThrow(InvalidReviewError);
    // v1 など別バージョンも弾く（regex は v4 のみ許容）
    expect(() => ReviewId.from('11111111-2222-1333-8444-555555555555')).toThrow(InvalidReviewError);
  });

  it('equals() は value 比較で同値判定する', () => {
    const a = ReviewId.from('11111111-2222-4333-8444-555555555555');
    const b = ReviewId.from('11111111-2222-4333-8444-555555555555');
    const c = ReviewId.from('99999999-2222-4333-8444-555555555555');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});
