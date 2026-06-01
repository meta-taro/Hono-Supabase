import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { Review } from '@/modules/reviews/domain/review';
import {
  InvalidReviewError,
  ReviewForbiddenError,
  ReviewNotFoundError,
} from '@/modules/reviews/domain/review.errors';
import type { ReviewStatus } from '@/modules/reviews/domain/review-status';
import { InMemoryReviewRepository } from './__test-helpers__/in-memory-review.repository';
import { InMemoryReviewHelpfulVoteRepository } from './__test-helpers__/in-memory-review-helpful-vote.repository';
import { createRemoveReviewHelpfulUseCase } from './remove-review-helpful.usecase';
import { createVoteReviewHelpfulUseCase } from './vote-review-helpful.usecase';

const silentLogger = createSilentLogger();
const CAKE_ID = '11111111-2222-4333-8444-555555555555';
const REVIEW_ID = '33333333-3333-4333-8333-333333333333';
const AUTHOR_ID = 'author-user';
const VOTER_ID = 'voter-user';
const OTHER_VOTER_ID = 'other-voter-user';

const buildReview = (overrides: { status?: ReviewStatus; userId?: string } = {}): Review =>
  Review.reconstruct({
    id: REVIEW_ID,
    cakeId: CAKE_ID,
    userId: overrides.userId ?? AUTHOR_ID,
    rating: 5,
    title: 'おいしい',
    body: '生クリームの甘さがちょうどよかったです',
    status: overrides.status ?? 'published',
    isVerifiedPurchaser: false,
    helpfulCount: 0,
    flagCount: 0,
    createdAt: new Date('2026-05-29T00:00:00.000Z'),
    updatedAt: new Date('2026-05-29T00:00:00.000Z'),
  });

const buildSut = (review?: Review) => {
  const reviewRepo = new InMemoryReviewRepository();
  if (review) reviewRepo.preload([review]);
  const voteRepo = new InMemoryReviewHelpfulVoteRepository();
  return {
    reviewRepo,
    voteRepo,
    vote: createVoteReviewHelpfulUseCase(reviewRepo, voteRepo, silentLogger),
    remove: createRemoveReviewHelpfulUseCase(reviewRepo, voteRepo, silentLogger),
  };
};

describe('voteReviewHelpfulUseCase', () => {
  it('他人の published レビューに投票すると voted=true / helpfulCount=1', async () => {
    const { vote, voteRepo } = buildSut(buildReview());

    const result = await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result).toEqual({ helpfulCount: 1, voted: true });
    expect(voteRepo.has(buildReview().id, VOTER_ID)).toBe(true);
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

  it('自分のレビューには投票できない（ReviewForbiddenError / 403）', async () => {
    const { vote, voteRepo } = buildSut(buildReview({ userId: AUTHOR_ID }));

    await expect(vote({ reviewId: REVIEW_ID, userId: AUTHOR_ID })).rejects.toThrow(
      ReviewForbiddenError,
    );
    expect(await voteRepo.countByReview(buildReview().id)).toBe(0);
  });

  it('存在しない reviewId は ReviewNotFoundError（404）', async () => {
    const { vote } = buildSut(); // preload なし

    await expect(vote({ reviewId: REVIEW_ID, userId: VOTER_ID })).rejects.toThrow(
      ReviewNotFoundError,
    );
  });

  it('published でないレビュー（hidden）は ReviewNotFoundError（404）', async () => {
    const { vote } = buildSut(buildReview({ status: 'hidden' }));

    await expect(vote({ reviewId: REVIEW_ID, userId: VOTER_ID })).rejects.toThrow(
      ReviewNotFoundError,
    );
  });

  it('壊れた reviewId は InvalidReviewError（400）', async () => {
    const { vote } = buildSut(buildReview());

    await expect(vote({ reviewId: 'not-a-uuid', userId: VOTER_ID })).rejects.toThrow(
      InvalidReviewError,
    );
  });

  it('成功時に info ログを出力する', async () => {
    const reviewRepo = new InMemoryReviewRepository();
    reviewRepo.preload([buildReview()]);
    const voteRepo = new InMemoryReviewHelpfulVoteRepository();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createVoteReviewHelpfulUseCase
    >[2];
    const vote = createVoteReviewHelpfulUseCase(reviewRepo, voteRepo, fakeLogger);

    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW_ID, userId: VOTER_ID, helpfulCount: 1 }),
      'Review helpful vote added',
    );
  });
});

describe('removeReviewHelpfulUseCase', () => {
  it('投票済みを取消すと voted=false / helpfulCount=0', async () => {
    const { vote, remove, voteRepo } = buildSut(buildReview());
    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });

    const result = await remove({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result).toEqual({ helpfulCount: 0, voted: false });
    expect(voteRepo.has(buildReview().id, VOTER_ID)).toBe(false);
  });

  it('未投票で取消しても no-op（voted=false / helpfulCount=0）', async () => {
    const { remove } = buildSut(buildReview());

    const result = await remove({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result).toEqual({ helpfulCount: 0, voted: false });
  });

  it('他ユーザーの投票は取消の影響を受けない', async () => {
    const { vote, remove } = buildSut(buildReview());
    await vote({ reviewId: REVIEW_ID, userId: VOTER_ID });
    await vote({ reviewId: REVIEW_ID, userId: OTHER_VOTER_ID });

    const result = await remove({ reviewId: REVIEW_ID, userId: VOTER_ID });

    expect(result.helpfulCount).toBe(1);
  });

  it('存在しないレビューの取消は ReviewNotFoundError（404）', async () => {
    const { remove } = buildSut();

    await expect(remove({ reviewId: REVIEW_ID, userId: VOTER_ID })).rejects.toThrow(
      ReviewNotFoundError,
    );
  });
});
