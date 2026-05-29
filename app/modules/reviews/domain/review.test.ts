import { describe, expect, it } from 'vitest';
import { CakeId } from './cake-id.vo';
import { Review } from './review';
import { InvalidRatingError, InvalidReviewError } from './review.errors';

const VALID_CAKE_ID = CakeId.from('11111111-2222-4333-8444-555555555555');
const VALID_AUTH_USER_ID = 'auth-user-abcdef';

const validInput = (overrides: Partial<Parameters<typeof Review.create>[0]> = {}) => ({
  cakeId: VALID_CAKE_ID,
  userId: VALID_AUTH_USER_ID,
  rating: 5,
  title: 'とても美味しかった',
  body: '生クリームの甘さが絶妙でした。リピート確定です。',
  isVerifiedPurchaser: true,
  ...overrides,
});

describe('Review.create()', () => {
  it('正常な入力で Review を生成できる（status は published / 集計は 0 から）', () => {
    const review = Review.create(validInput());
    expect(review.cakeId.equals(VALID_CAKE_ID)).toBe(true);
    expect(review.userId).toBe(VALID_AUTH_USER_ID);
    expect(review.rating.value).toBe(5);
    expect(review.title).toBe('とても美味しかった');
    expect(review.body).toBe('生クリームの甘さが絶妙でした。リピート確定です。');
    expect(review.status).toBe('published');
    expect(review.isVerifiedPurchaser).toBe(true);
    expect(review.helpfulCount).toBe(0);
    expect(review.flagCount).toBe(0);
    expect(review.createdAt).toBeInstanceOf(Date);
    expect(review.updatedAt).toBeInstanceOf(Date);
  });

  it('生成のたびに異なる ReviewId が割り当てられる', () => {
    const a = Review.create(validInput());
    const b = Review.create(validInput());
    expect(a.id.value).not.toBe(b.id.value);
  });

  it('title / body の前後空白は trim される', () => {
    const review = Review.create(validInput({ title: '  trimmed  ', body: '  body trimmed  ' }));
    expect(review.title).toBe('trimmed');
    expect(review.body).toBe('body trimmed');
  });

  it('userId が空文字 / 空白だけなら InvalidReviewError', () => {
    expect(() => Review.create(validInput({ userId: '' }))).toThrow(InvalidReviewError);
    expect(() => Review.create(validInput({ userId: '   ' }))).toThrow(InvalidReviewError);
  });

  it('title が trim 後 0 文字なら InvalidReviewError', () => {
    expect(() => Review.create(validInput({ title: '' }))).toThrow(InvalidReviewError);
    expect(() => Review.create(validInput({ title: '   ' }))).toThrow(InvalidReviewError);
  });

  it('title が 100 文字超なら InvalidReviewError', () => {
    expect(() => Review.create(validInput({ title: 'a'.repeat(101) }))).toThrow(InvalidReviewError);
    // 境界値 100 はちょうど通る
    expect(() => Review.create(validInput({ title: 'a'.repeat(100) }))).not.toThrow();
  });

  it('body が trim 後 0 文字なら InvalidReviewError', () => {
    expect(() => Review.create(validInput({ body: '' }))).toThrow(InvalidReviewError);
    expect(() => Review.create(validInput({ body: '   ' }))).toThrow(InvalidReviewError);
  });

  it('body が 2000 文字超なら InvalidReviewError', () => {
    expect(() => Review.create(validInput({ body: 'a'.repeat(2001) }))).toThrow(InvalidReviewError);
    expect(() => Review.create(validInput({ body: 'a'.repeat(2000) }))).not.toThrow();
  });

  it('rating が範囲外なら InvalidRatingError（Rating.of に委譲）', () => {
    expect(() => Review.create(validInput({ rating: 0 }))).toThrow(InvalidRatingError);
    expect(() => Review.create(validInput({ rating: 6 }))).toThrow(InvalidRatingError);
  });

  it('rating が小数なら InvalidRatingError', () => {
    expect(() => Review.create(validInput({ rating: 3.5 }))).toThrow(InvalidRatingError);
  });
});

describe('Review.reconstruct()', () => {
  const validProps = () => ({
    id: '11111111-2222-4333-8444-555555555555',
    cakeId: '11111111-2222-4333-8444-555555555555',
    userId: 'auth-user-abc',
    rating: 4,
    title: 'restored',
    body: 'restored body',
    status: 'published',
    isVerifiedPurchaser: false,
    helpfulCount: 7,
    flagCount: 2,
    createdAt: new Date('2026-05-25T10:00:00Z'),
    updatedAt: new Date('2026-05-26T12:00:00Z'),
  });

  it('DB 由来の値を Review に復元できる', () => {
    const review = Review.reconstruct(validProps());
    expect(review.id.value).toBe('11111111-2222-4333-8444-555555555555');
    expect(review.helpfulCount).toBe(7);
    expect(review.flagCount).toBe(2);
    expect(review.status).toBe('published');
  });

  it('未知の status は InvalidReviewError', () => {
    expect(() => Review.reconstruct({ ...validProps(), status: 'pending' })).toThrow(
      InvalidReviewError,
    );
  });

  it('壊れた UUID は VO の検証で InvalidReviewError', () => {
    expect(() => Review.reconstruct({ ...validProps(), id: 'not-uuid' })).toThrow(
      InvalidReviewError,
    );
  });

  it('range 外の rating は InvalidRatingError', () => {
    expect(() => Review.reconstruct({ ...validProps(), rating: 99 })).toThrow(InvalidRatingError);
  });
});
