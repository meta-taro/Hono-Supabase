import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { ReviewAlreadyExistsError } from '@/modules/reviews/domain/review.errors';
import { InMemoryReviewRepository } from './__test-helpers__/in-memory-review.repository';
import { InMemoryVerifiedPurchaserChecker } from './__test-helpers__/in-memory-verified-purchaser.checker';
import { createPostReviewUseCase } from './post-review.usecase';
import { InvalidReviewError } from '@/modules/reviews/domain/review.errors';

const silentLogger = createSilentLogger();
const VALID_CAKE_ID = '11111111-2222-4333-8444-555555555555';
const VALID_USER_ID = 'auth-user-abcdef';

const validInput = (
  overrides: Partial<Parameters<ReturnType<typeof createPostReviewUseCase>>[0]> = {},
) => ({
  cakeId: VALID_CAKE_ID,
  userId: VALID_USER_ID,
  rating: 5,
  title: 'おいしい',
  body: '生クリームの甘さがちょうどよかったです',
  ...overrides,
});

describe('postReviewUseCase', () => {
  it('正常入力でレビューを生成し、リポジトリに保存される', async () => {
    const repo = new InMemoryReviewRepository();
    const checker = new InMemoryVerifiedPurchaserChecker();
    const postReview = createPostReviewUseCase(repo, checker, silentLogger);

    const review = await postReview(validInput());

    expect(review.cakeId.value).toBe(VALID_CAKE_ID);
    expect(review.userId).toBe(VALID_USER_ID);
    expect(review.rating.value).toBe(5);
    expect(review.status).toBe('published');
    expect(review.isVerifiedPurchaser).toBe(false);

    const saved = await repo.findById(review.id);
    expect(saved?.id.value).toBe(review.id.value);
  });

  it('購入実績ありの user は is_verified_purchaser=true で snapshot される', async () => {
    const repo = new InMemoryReviewRepository();
    const checker = new InMemoryVerifiedPurchaserChecker([
      { authUserId: VALID_USER_ID, cakeId: VALID_CAKE_ID },
    ]);
    const postReview = createPostReviewUseCase(repo, checker, silentLogger);

    const review = await postReview(validInput());

    expect(review.isVerifiedPurchaser).toBe(true);
  });

  it('同一 user × 同一 cake への 2 回目の投稿は ReviewAlreadyExistsError', async () => {
    const repo = new InMemoryReviewRepository();
    const checker = new InMemoryVerifiedPurchaserChecker();
    const postReview = createPostReviewUseCase(repo, checker, silentLogger);

    await postReview(validInput());

    await expect(postReview(validInput())).rejects.toThrow(ReviewAlreadyExistsError);
  });

  it('別 user なら同一 cake に投稿できる', async () => {
    const repo = new InMemoryReviewRepository();
    const checker = new InMemoryVerifiedPurchaserChecker();
    const postReview = createPostReviewUseCase(repo, checker, silentLogger);

    await postReview(validInput({ userId: 'user-A' }));
    await expect(postReview(validInput({ userId: 'user-B' }))).resolves.toBeDefined();
  });

  it('壊れた cakeId は InvalidReviewError', async () => {
    const repo = new InMemoryReviewRepository();
    const checker = new InMemoryVerifiedPurchaserChecker();
    const postReview = createPostReviewUseCase(repo, checker, silentLogger);

    await expect(postReview(validInput({ cakeId: 'not-a-uuid' }))).rejects.toThrow(
      InvalidReviewError,
    );
  });

  it('成功時に info ログを出力する', async () => {
    const repo = new InMemoryReviewRepository();
    const checker = new InMemoryVerifiedPurchaserChecker();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createPostReviewUseCase
    >[2];
    const postReview = createPostReviewUseCase(repo, checker, fakeLogger);

    const review = await postReview(validInput());

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: review.id.value,
        cakeId: review.cakeId.value,
        userId: review.userId,
        rating: 5,
        isVerifiedPurchaser: false,
      }),
      'Review posted',
    );
  });
});
