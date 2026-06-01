import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import {
  ShopReviewForbiddenError,
  ShopReviewNotFoundError,
} from '@/modules/reviews/domain/shop-review.errors';
import { InvalidReviewError } from '@/modules/reviews/domain/review.errors';
import type { ReviewStatus } from '@/modules/reviews/domain/review-status';
import { InMemoryShopReviewRepository } from './__test-helpers__/in-memory-shop-review.repository';
import { InMemoryShopReviewHelpfulVoteRepository } from './__test-helpers__/in-memory-shop-review-helpful-vote.repository';
import { createRemoveShopReviewHelpfulUseCase } from './remove-shop-review-helpful.usecase';
import { createVoteShopReviewHelpfulUseCase } from './vote-shop-review-helpful.usecase';

const silentLogger = createSilentLogger();
const REVIEW_ID = '33333333-3333-4333-8333-333333333333';
const AUTHOR_ID = 'author-user';
const VOTER_ID = 'voter-user';
const OTHER_VOTER_ID = 'other-voter-user';

const buildReview = (overrides: { status?: ReviewStatus; userId?: string } = {}): ShopReview =>
  ShopReview.reconstruct({
    id: REVIEW_ID,
    userId: overrides.userId ?? AUTHOR_ID,
    rating: 5,
    title: '良いお店',
    body: '接客が丁寧でケーキも美味しかったです',
    status: overrides.status ?? 'published',
    isVerifiedCustomer: false,
    helpfulCount: 0,
    flagCount: 0,
    createdAt: new Date('2026-05-29T00:00:00.000Z'),
    updatedAt: new Date('2026-05-29T00:00:00.000Z'),
  });

const buildSut = (review?: ShopReview) => {
  const reviewRepo = new InMemoryShopReviewRepository();
  if (review) reviewRepo.preload([review]);
  const voteRepo = new InMemoryShopReviewHelpfulVoteRepository();
  return {
    reviewRepo,
    voteRepo,
    vote: createVoteShopReviewHelpfulUseCase(reviewRepo, voteRepo, silentLogger),
    remove: createRemoveShopReviewHelpfulUseCase(reviewRepo, voteRepo, silentLogger),
  };
};

describe('voteShopReviewHelpfulUseCase', () => {
  it('他人の published レビューに投票すると voted=true / helpfulCount=1', async () => {
    const { vote } = buildSut(buildReview());

    const result = await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result).toEqual({ helpfulCount: 1, voted: true });
  });

  it('同一ユーザーが 2 回投票しても helpfulCount は 1 のまま（冪等）', async () => {
    const { vote } = buildSut(buildReview());

    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });
    const second = await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(second).toEqual({ helpfulCount: 1, voted: true });
  });

  it('複数ユーザーの投票はそれぞれカウントされる', async () => {
    const { vote } = buildSut(buildReview());

    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });
    const second = await vote({ reviewId: REVIEW_ID, userId: OTHER_VOTER_ID });

    expect(second.helpfulCount).toBe(2);
  });

  it('自分のレビューには投票できない（ShopReviewForbiddenError / 403）', async () => {
    const { vote, voteRepo } = buildSut(buildReview({ userId: AUTHOR_ID }));

    await expect(vote({ reviewId: REVIEW_ID, userId: AUTHOR_ID })).rejects.toThrow(
      ShopReviewForbiddenError,
    );
    expect(await voteRepo.countByReview(buildReview().id)).toBe(0);
  });

  it('存在しない reviewId は ShopReviewNotFoundError（404）', async () => {
    const { vote } = buildSut();

    await expect(vote({ reviewId: REVIEW_ID, userId: VOTER_ID })).rejects.toThrow(
      ShopReviewNotFoundError,
    );
  });

  it('published でないレビュー（removed）は ShopReviewNotFoundError（404）', async () => {
    const { vote } = buildSut(buildReview({ status: 'removed' }));

    await expect(vote({ reviewId: REVIEW_ID, userId: VOTER_ID })).rejects.toThrow(
      ShopReviewNotFoundError,
    );
  });

  it('壊れた reviewId は InvalidReviewError（400）', async () => {
    const { vote } = buildSut(buildReview());

    await expect(vote({ reviewId: 'not-a-uuid', userId: VOTER_ID })).rejects.toThrow(
      InvalidReviewError,
    );
  });

  it('成功時に info ログを出力する', async () => {
    const reviewRepo = new InMemoryShopReviewRepository();
    reviewRepo.preload([buildReview()]);
    const voteRepo = new InMemoryShopReviewHelpfulVoteRepository();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createVoteShopReviewHelpfulUseCase
    >[2];
    const vote = createVoteShopReviewHelpfulUseCase(reviewRepo, voteRepo, fakeLogger);

    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW_ID, userId: VOTER_ID, helpfulCount: 1 }),
      'Shop review helpful vote added',
    );
  });
});

describe('removeShopReviewHelpfulUseCase', () => {
  it('投票済みを取消すと voted=false / helpfulCount=0', async () => {
    const { vote, remove } = buildSut(buildReview());
    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    const result = await remove({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result).toEqual({ helpfulCount: 0, voted: false });
  });

  it('未投票で取消しても no-op（voted=false / helpfulCount=0）', async () => {
    const { remove } = buildSut(buildReview());

    const result = await remove({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result).toEqual({ helpfulCount: 0, voted: false });
  });

  it('存在しないレビューの取消は ShopReviewNotFoundError（404）', async () => {
    const { remove } = buildSut();

    await expect(remove({ reviewId: REVIEW_ID, userId: VOTER_ID })).rejects.toThrow(
      ShopReviewNotFoundError,
    );
  });
});
