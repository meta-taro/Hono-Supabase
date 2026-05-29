import { describe, expect, it } from 'vitest';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import { InMemoryShopReviewRepository } from './__test-helpers__/in-memory-shop-review.repository';
import { createListShopReviewsUseCase } from './list-shop-reviews.usecase';

const seedReviews = (repo: InMemoryShopReviewRepository): ShopReview[] => {
  const reviews = [
    ShopReview.reconstruct({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'u1',
      rating: 5,
      title: 't1',
      body: 'b1',
      status: 'published',
      isVerifiedCustomer: true,
      helpfulCount: 10,
      flagCount: 0,
      createdAt: new Date('2026-05-20T10:00:00Z'),
      updatedAt: new Date('2026-05-20T10:00:00Z'),
    }),
    ShopReview.reconstruct({
      id: '22222222-2222-4222-8222-222222222222',
      userId: 'u2',
      rating: 4,
      title: 't2',
      body: 'b2',
      status: 'published',
      isVerifiedCustomer: false,
      helpfulCount: 30,
      flagCount: 0,
      createdAt: new Date('2026-05-21T10:00:00Z'),
      updatedAt: new Date('2026-05-21T10:00:00Z'),
    }),
    ShopReview.reconstruct({
      id: '33333333-3333-4333-8333-333333333333',
      userId: 'u3',
      rating: 3,
      title: 't3',
      body: 'b3',
      status: 'published',
      isVerifiedCustomer: true,
      helpfulCount: 20,
      flagCount: 0,
      createdAt: new Date('2026-05-22T10:00:00Z'),
      updatedAt: new Date('2026-05-22T10:00:00Z'),
    }),
    // hidden → list / stats から除外
    ShopReview.reconstruct({
      id: '55555555-5555-4555-8555-555555555555',
      userId: 'u5',
      rating: 1,
      title: 't5',
      body: 'b5',
      status: 'hidden',
      isVerifiedCustomer: false,
      helpfulCount: 100,
      flagCount: 0,
      createdAt: new Date('2026-05-24T10:00:00Z'),
      updatedAt: new Date('2026-05-24T10:00:00Z'),
    }),
  ];
  repo.preload(reviews);
  return reviews;
};

describe('listShopReviewsUseCase', () => {
  it('newest ソートで published のみを新しい順に返し、stats も同梱する', async () => {
    const repo = new InMemoryShopReviewRepository();
    seedReviews(repo);
    const listReviews = createListShopReviewsUseCase(repo);

    const { page, stats } = await listReviews({ limit: 10, sort: 'newest' });

    expect(page.reviews.map((r) => r.id.value)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(page.nextCursor).toBeNull();

    // hidden は除外され、published 3 件（5+4+3）/3 = 4.00
    expect(stats.count).toBe(3);
    expect(stats.average).toBe(4);
    expect(stats.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });
  });

  it('helpful ソートで helpful_count が多い順に並ぶ', async () => {
    const repo = new InMemoryShopReviewRepository();
    seedReviews(repo);
    const listReviews = createListShopReviewsUseCase(repo);

    const { page } = await listReviews({ limit: 10, sort: 'helpful' });

    // 30 > 20 > 10
    expect(page.reviews.map((r) => r.helpfulCount)).toEqual([30, 20, 10]);
  });

  it('filterRating=5 で星 5 のみに絞り込める', async () => {
    const repo = new InMemoryShopReviewRepository();
    seedReviews(repo);
    const listReviews = createListShopReviewsUseCase(repo);

    const { page } = await listReviews({ limit: 10, sort: 'newest', filterRating: 5 });

    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0]?.rating.value).toBe(5);
  });

  it('verifiedOnly=true で is_verified_customer=true のみに絞り込める', async () => {
    const repo = new InMemoryShopReviewRepository();
    seedReviews(repo);
    const listReviews = createListShopReviewsUseCase(repo);

    const { page } = await listReviews({ limit: 10, sort: 'newest', verifiedOnly: true });

    expect(page.reviews.map((r) => r.isVerifiedCustomer)).toEqual([true, true]);
  });

  it('limit を超える件数で nextCursor が発行され、続きを取れる', async () => {
    const repo = new InMemoryShopReviewRepository();
    seedReviews(repo);
    const listReviews = createListShopReviewsUseCase(repo);

    const first = await listReviews({ limit: 2, sort: 'newest' });
    expect(first.page.reviews).toHaveLength(2);
    expect(first.page.nextCursor).not.toBeNull();

    const second = await listReviews({
      limit: 2,
      sort: 'newest',
      ...(first.page.nextCursor ? { after: first.page.nextCursor } : {}),
    });
    expect(second.page.reviews).toHaveLength(1);
    expect(second.page.nextCursor).toBeNull();

    const allIds = [...first.page.reviews, ...second.page.reviews].map((r) => r.id.value);
    expect(new Set(allIds).size).toBe(3); // 重複なし
  });

  it('レビューが 0 件なら stats は count=0 / average=null', async () => {
    const repo = new InMemoryShopReviewRepository();
    const listReviews = createListShopReviewsUseCase(repo);

    const { page, stats } = await listReviews({ limit: 10, sort: 'newest' });

    expect(page.reviews).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(stats).toEqual({
      count: 0,
      average: null,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });
});
