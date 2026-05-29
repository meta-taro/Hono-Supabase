import { describe, expect, it } from 'vitest';
import { InvalidRatingError } from './review.errors';
import { ShopReview } from './shop-review';
import { InvalidShopReviewError } from './shop-review.errors';

const VALID_AUTH_USER_ID = 'auth-user-abcdef';

const validInput = (overrides: Partial<Parameters<typeof ShopReview.create>[0]> = {}) => ({
  userId: VALID_AUTH_USER_ID,
  rating: 5,
  title: '雰囲気のよい店でした',
  body: '接客が丁寧で、ケーキの説明も詳しくしてくれました。また来ます。',
  isVerifiedCustomer: true,
  ...overrides,
});

describe('ShopReview.create()', () => {
  it('正常な入力で ShopReview を生成できる（status は published / 集計は 0 から）', () => {
    const review = ShopReview.create(validInput());
    expect(review.userId).toBe(VALID_AUTH_USER_ID);
    expect(review.rating.value).toBe(5);
    expect(review.title).toBe('雰囲気のよい店でした');
    expect(review.body).toBe('接客が丁寧で、ケーキの説明も詳しくしてくれました。また来ます。');
    expect(review.status).toBe('published');
    expect(review.isVerifiedCustomer).toBe(true);
    expect(review.helpfulCount).toBe(0);
    expect(review.flagCount).toBe(0);
    expect(review.createdAt).toBeInstanceOf(Date);
    expect(review.updatedAt).toBeInstanceOf(Date);
  });

  it('生成のたびに異なる ReviewId が割り当てられる', () => {
    const a = ShopReview.create(validInput());
    const b = ShopReview.create(validInput());
    expect(a.id.value).not.toBe(b.id.value);
  });

  it('title / body の前後空白は trim される', () => {
    const review = ShopReview.create(
      validInput({ title: '  trimmed  ', body: '  body trimmed  ' }),
    );
    expect(review.title).toBe('trimmed');
    expect(review.body).toBe('body trimmed');
  });

  it('userId が空文字 / 空白だけなら InvalidShopReviewError', () => {
    expect(() => ShopReview.create(validInput({ userId: '' }))).toThrow(InvalidShopReviewError);
    expect(() => ShopReview.create(validInput({ userId: '   ' }))).toThrow(InvalidShopReviewError);
  });

  it('title が trim 後 0 文字なら InvalidShopReviewError', () => {
    expect(() => ShopReview.create(validInput({ title: '' }))).toThrow(InvalidShopReviewError);
    expect(() => ShopReview.create(validInput({ title: '   ' }))).toThrow(InvalidShopReviewError);
  });

  it('title が 100 文字超なら InvalidShopReviewError', () => {
    expect(() => ShopReview.create(validInput({ title: 'a'.repeat(101) }))).toThrow(
      InvalidShopReviewError,
    );
    // 境界値 100 はちょうど通る
    expect(() => ShopReview.create(validInput({ title: 'a'.repeat(100) }))).not.toThrow();
  });

  it('body が trim 後 0 文字なら InvalidShopReviewError', () => {
    expect(() => ShopReview.create(validInput({ body: '' }))).toThrow(InvalidShopReviewError);
    expect(() => ShopReview.create(validInput({ body: '   ' }))).toThrow(InvalidShopReviewError);
  });

  it('body が 2000 文字超なら InvalidShopReviewError', () => {
    expect(() => ShopReview.create(validInput({ body: 'a'.repeat(2001) }))).toThrow(
      InvalidShopReviewError,
    );
    expect(() => ShopReview.create(validInput({ body: 'a'.repeat(2000) }))).not.toThrow();
  });

  it('rating が範囲外なら InvalidRatingError（Rating.of に委譲）', () => {
    expect(() => ShopReview.create(validInput({ rating: 0 }))).toThrow(InvalidRatingError);
    expect(() => ShopReview.create(validInput({ rating: 6 }))).toThrow(InvalidRatingError);
  });

  it('rating が小数なら InvalidRatingError', () => {
    expect(() => ShopReview.create(validInput({ rating: 3.5 }))).toThrow(InvalidRatingError);
  });
});

describe('ShopReview.reconstruct()', () => {
  const validProps = () => ({
    id: '11111111-2222-4333-8444-555555555555',
    userId: 'auth-user-abc',
    rating: 4,
    title: 'restored',
    body: 'restored body',
    status: 'published',
    isVerifiedCustomer: false,
    helpfulCount: 7,
    flagCount: 2,
    createdAt: new Date('2026-05-25T10:00:00Z'),
    updatedAt: new Date('2026-05-26T12:00:00Z'),
  });

  it('DB 由来の値を ShopReview に復元できる', () => {
    const review = ShopReview.reconstruct(validProps());
    expect(review.id.value).toBe('11111111-2222-4333-8444-555555555555');
    expect(review.helpfulCount).toBe(7);
    expect(review.flagCount).toBe(2);
    expect(review.status).toBe('published');
    expect(review.isVerifiedCustomer).toBe(false);
  });

  it('未知の status は InvalidShopReviewError', () => {
    expect(() => ShopReview.reconstruct({ ...validProps(), status: 'pending' })).toThrow(
      InvalidShopReviewError,
    );
  });

  it('壊れた UUID は VO の検証で弾かれる', () => {
    expect(() => ShopReview.reconstruct({ ...validProps(), id: 'not-uuid' })).toThrow();
  });

  it('range 外の rating は InvalidRatingError', () => {
    expect(() => ShopReview.reconstruct({ ...validProps(), rating: 99 })).toThrow(
      InvalidRatingError,
    );
  });
});
