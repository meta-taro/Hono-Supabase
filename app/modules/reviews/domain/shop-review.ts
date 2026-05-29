import { Rating } from './rating.vo';
import { ReviewId } from './review-id.vo';
import { type ReviewStatus, isReviewStatus } from './review-status';
import { InvalidShopReviewError } from './shop-review.errors';

const TITLE_MIN_LENGTH = 1;
const TITLE_MAX_LENGTH = 100;
const BODY_MIN_LENGTH = 1;
const BODY_MAX_LENGTH = 2000;

// 新規投稿時の集計カウンタ。helpful_count / flag_count は DB の DEFAULT 0 と一致させる
// （Phase 11 Step 3 / Step 4 で増減ロジックを追加する）。
const INITIAL_HELPFUL_COUNT = 0;
const INITIAL_FLAG_COUNT = 0;

// authUserId（Supabase auth.users.id）の検証。VO 化はしないが、空文字や未指定は弾く。
const assertAuthUserId = (value: string): void => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidShopReviewError('userId は必須です');
  }
};

// ShopReview = 店舗そのものに対するレビュー（集約根）。
//   - cakes レビュー（Review）とは別 Aggregate。cakeId を持たない（単一店舗のため shopId も持たない）。
//   - Rating / ReviewId / ReviewStatus は reviews コンテキスト内の VO を再利用する
//     （cake 固有ではない汎用 VO のため、コンテキスト間参照には当たらない）。
//   - is_verified_customer はレビュー投稿時のスナップショット。後で注文がキャンセルされても
//     「投稿時点では確かに利用客だった」事実は変えない。判定そのものは domain 外の port
//     （OrderHistoryChecker）に委譲する。
export class ShopReview {
  private constructor(
    public readonly id: ReviewId,
    public readonly userId: string,
    public readonly rating: Rating,
    public readonly title: string,
    public readonly body: string,
    public readonly status: ReviewStatus,
    public readonly isVerifiedCustomer: boolean,
    public readonly helpfulCount: number,
    public readonly flagCount: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  // 新規投稿: 業務ルール（title / body の長さ・rating の範囲）をすべて適用する。
  static create(input: {
    userId: string;
    rating: number;
    title: string;
    body: string;
    isVerifiedCustomer: boolean;
  }): ShopReview {
    assertAuthUserId(input.userId);
    const trimmedTitle = input.title.trim();
    if (trimmedTitle.length < TITLE_MIN_LENGTH) {
      throw new InvalidShopReviewError('タイトルは必須です');
    }
    if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      throw new InvalidShopReviewError(`タイトルは ${String(TITLE_MAX_LENGTH)} 文字以内です`);
    }
    const trimmedBody = input.body.trim();
    if (trimmedBody.length < BODY_MIN_LENGTH) {
      throw new InvalidShopReviewError('本文は必須です');
    }
    if (trimmedBody.length > BODY_MAX_LENGTH) {
      throw new InvalidShopReviewError(`本文は ${String(BODY_MAX_LENGTH)} 文字以内です`);
    }
    const now = new Date();
    return new ShopReview(
      ReviewId.generate(),
      input.userId,
      Rating.of(input.rating),
      trimmedTitle,
      trimmedBody,
      'published',
      input.isVerifiedCustomer,
      INITIAL_HELPFUL_COUNT,
      INITIAL_FLAG_COUNT,
      now,
      now,
    );
  }

  // 永続化層からの復元: DB の値を信頼するが、VO 経由は必ず通すため
  // 壊れた UUID / rating / status はここで弾かれる（Fail-Fast）。
  static reconstruct(props: {
    id: string;
    userId: string;
    rating: number;
    title: string;
    body: string;
    status: string;
    isVerifiedCustomer: boolean;
    helpfulCount: number;
    flagCount: number;
    createdAt: Date;
    updatedAt: Date;
  }): ShopReview {
    if (!isReviewStatus(props.status)) {
      throw new InvalidShopReviewError(`未知の review status: ${props.status}`);
    }
    assertAuthUserId(props.userId);
    return new ShopReview(
      ReviewId.from(props.id),
      props.userId,
      Rating.of(props.rating),
      props.title,
      props.body,
      props.status,
      props.isVerifiedCustomer,
      props.helpfulCount,
      props.flagCount,
      props.createdAt,
      props.updatedAt,
    );
  }
}
