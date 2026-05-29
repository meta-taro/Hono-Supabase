import { describe, expect, it, vi } from 'vitest';
import { ShopReviewAlreadyExistsError } from '@/modules/reviews/domain/shop-review.errors';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { InMemoryOrderHistoryChecker } from './__test-helpers__/in-memory-order-history.checker';
import { InMemoryShopReviewRepository } from './__test-helpers__/in-memory-shop-review.repository';
import { createPostShopReviewUseCase } from './post-shop-review.usecase';

const silentLogger = createSilentLogger();
const VALID_USER_ID = 'auth-user-abcdef';

const validInput = (
  overrides: Partial<Parameters<ReturnType<typeof createPostShopReviewUseCase>>[0]> = {},
) => ({
  userId: VALID_USER_ID,
  rating: 5,
  title: '雰囲気がよい',
  body: '接客が丁寧で居心地のよい店でした',
  ...overrides,
});

describe('postShopReviewUseCase', () => {
  it('正常入力でレビューを生成し、リポジトリに保存される', async () => {
    const repo = new InMemoryShopReviewRepository();
    const checker = new InMemoryOrderHistoryChecker();
    const postReview = createPostShopReviewUseCase(repo, checker, silentLogger);

    const review = await postReview(validInput());

    expect(review.userId).toBe(VALID_USER_ID);
    expect(review.rating.value).toBe(5);
    expect(review.status).toBe('published');
    expect(review.isVerifiedCustomer).toBe(false);

    const saved = await repo.findById(review.id);
    expect(saved?.id.value).toBe(review.id.value);
  });

  it('利用実績ありの user は is_verified_customer=true で snapshot される', async () => {
    const repo = new InMemoryShopReviewRepository();
    const checker = new InMemoryOrderHistoryChecker([VALID_USER_ID]);
    const postReview = createPostShopReviewUseCase(repo, checker, silentLogger);

    const review = await postReview(validInput());

    expect(review.isVerifiedCustomer).toBe(true);
  });

  it('同一 user の 2 回目の投稿は ShopReviewAlreadyExistsError', async () => {
    const repo = new InMemoryShopReviewRepository();
    const checker = new InMemoryOrderHistoryChecker();
    const postReview = createPostShopReviewUseCase(repo, checker, silentLogger);

    await postReview(validInput());

    await expect(postReview(validInput())).rejects.toThrow(ShopReviewAlreadyExistsError);
  });

  it('別 user なら投稿できる', async () => {
    const repo = new InMemoryShopReviewRepository();
    const checker = new InMemoryOrderHistoryChecker();
    const postReview = createPostShopReviewUseCase(repo, checker, silentLogger);

    await postReview(validInput({ userId: 'user-A' }));
    await expect(postReview(validInput({ userId: 'user-B' }))).resolves.toBeDefined();
  });

  it('成功時に info ログを出力する', async () => {
    const repo = new InMemoryShopReviewRepository();
    const checker = new InMemoryOrderHistoryChecker();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createPostShopReviewUseCase
    >[2];
    const postReview = createPostShopReviewUseCase(repo, checker, fakeLogger);

    const review = await postReview(validInput());

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: review.id.value,
        userId: review.userId,
        rating: 5,
        isVerifiedCustomer: false,
      }),
      'Shop review posted',
    );
  });
});
