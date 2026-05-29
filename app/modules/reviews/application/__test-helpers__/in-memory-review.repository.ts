import type { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import { Review } from '@/modules/reviews/domain/review';
import type {
  ListReviewsByCakeParams,
  ReviewListCursor,
  ReviewPage,
  ReviewRepository,
  ReviewStats,
} from '@/modules/reviews/domain/review.repository';
import type { ReviewId } from '@/modules/reviews/domain/review-id.vo';

// テスト用の in-memory 実装。
//   - Map<reviewId, Review> で保持。
//   - listByCake は sort（newest / helpful）と filter（rating / verifiedOnly）と after を再現。
//   - statsByCake は published のみを集計。
//   - existsActiveByCakeAndUser は published / hidden のみを「存在」とみなす（removed は無視）。
//
// 実 DB の挙動（特に Postgres の文字列比較 / NULL 並び）と完全一致は目指さない。
// 本番経路の検証は infrastructure 層の workers プールテストに任せる。
export class InMemoryReviewRepository implements ReviewRepository {
  private readonly store = new Map<string, Review>();

  // テスト用: 直接 Review を差し込む（fixture 構築のため）。
  preload(reviews: Review[]): void {
    for (const review of reviews) {
      this.store.set(review.id.value, review);
    }
  }

  async save(review: Review): Promise<void> {
    this.store.set(review.id.value, review);
  }

  async findById(id: ReviewId): Promise<Review | null> {
    return this.store.get(id.value) ?? null;
  }

  async listByCake(params: ListReviewsByCakeParams): Promise<ReviewPage> {
    const all = Array.from(this.store.values())
      // 対象 cake のレビューのみ・public のみ
      .filter((r) => r.cakeId.equals(params.cakeId) && r.status === 'published')
      .filter((r) =>
        params.filterRating === undefined ? true : r.rating.value === params.filterRating,
      )
      .filter((r) => (params.verifiedOnly === true ? r.isVerifiedPurchaser : true));

    // ソート: newest は created_at DESC, id DESC / helpful は helpful_count DESC + created_at DESC + id DESC
    all.sort((a, b) => {
      if (params.sort === 'helpful' && a.helpfulCount !== b.helpfulCount) {
        return b.helpfulCount - a.helpfulCount;
      }
      const tCmp = b.createdAt.getTime() - a.createdAt.getTime();
      if (tCmp !== 0) return tCmp;
      // id は文字列比較で安定 tiebreaker（DESC）
      return a.id.value < b.id.value ? 1 : a.id.value > b.id.value ? -1 : 0;
    });

    const fromAfter = params.after ? this.applyAfter(all, params.after, params.sort) : all;

    const hasMore = fromAfter.length > params.limit;
    const page = hasMore ? fromAfter.slice(0, params.limit) : fromAfter;
    const last = page[page.length - 1];
    const nextCursor: ReviewListCursor | null =
      hasMore && last
        ? {
            sort: params.sort,
            createdAt: last.createdAt.toISOString(),
            id: last.id.value,
            ...(params.sort === 'helpful' ? { helpfulCount: last.helpfulCount } : {}),
          }
        : null;

    return { reviews: page, nextCursor };
  }

  // after より「並びの後ろ」だけ残す（同じソート規則で再フィルタする）。
  private applyAfter(
    sorted: Review[],
    after: ReviewListCursor,
    sort: ListReviewsByCakeParams['sort'],
  ): Review[] {
    const afterCreated = new Date(after.createdAt).getTime();
    return sorted.filter((r) => {
      if (sort === 'helpful') {
        const afterHelpful = after.helpfulCount ?? 0;
        if (r.helpfulCount !== afterHelpful) return r.helpfulCount < afterHelpful;
      }
      const t = r.createdAt.getTime();
      if (t !== afterCreated) return t < afterCreated;
      return r.id.value < after.id;
    });
  }

  async statsByCake(cakeId: CakeId): Promise<ReviewStats> {
    const published = Array.from(this.store.values()).filter(
      (r) => r.cakeId.equals(cakeId) && r.status === 'published',
    );
    const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of published) {
      const k = r.rating.value as 1 | 2 | 3 | 4 | 5;
      distribution[k] += 1;
    }
    const count = published.length;
    const average =
      count === 0
        ? null
        : Math.round((published.reduce((s, r) => s + r.rating.value, 0) / count) * 100) / 100;
    return { count, average, distribution };
  }

  async existsActiveByCakeAndUser(cakeId: CakeId, userId: string): Promise<boolean> {
    return Array.from(this.store.values()).some(
      (r) => r.cakeId.equals(cakeId) && r.userId === userId && r.status !== 'removed',
    );
  }
}
