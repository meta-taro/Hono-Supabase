import { CakeId } from './cake-id.vo';
import { Rating } from './rating.vo';
import { ReviewId } from './review-id.vo';
import { type ReviewStatus, isReviewStatus } from './review-status';
import { InvalidReviewError } from './review.errors';

const TITLE_MIN_LENGTH = 1;
const TITLE_MAX_LENGTH = 100;
const BODY_MIN_LENGTH = 1;
const BODY_MAX_LENGTH = 2000;

// 新規投稿時の集計カウンタ。helpful_count / flag_count は DB の DEFAULT 0 と一致させる
// （Phase 11 Step 3 / Step 4 で増減ロジックを追加する）。
const INITIAL_HELPFUL_COUNT = 0;
const INITIAL_FLAG_COUNT = 0;

// authUserId（Supabase auth.users.id）の検証。VO 化はしないが、空文字や未指定は弾く。
// 厳密な UUID 検証は customers ↔ auth の境界で行うため、ここでは「空でない」だけを担保する。
const assertAuthUserId = (value: string): void => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidReviewError('userId は必須です');
  }
};

// Review = ケーキに対するレビュー（集約根）。
//   - 「タイトル / 本文の長さ」「rating が 1〜5」「status enum」など投稿の不変条件を
//     constructor を private にして create() / reconstruct() の 2 経路でのみ守る。
//   - verified_purchaser はレビュー投稿時のスナップショット。後で注文がキャンセル
//     されても「投稿時点では確かに購入していた」事実は変えない（過去の真実保存）。
//     判定そのものは domain 外の port（VerifiedPurchaserChecker）に委譲する。
//   - 集計カウンタ（helpful_count / flag_count）は反正規化された値で、Phase 11 Step 3/4 で
//     DB トリガから更新される。Read 経路では DB の値をそのまま運ぶ。
export class Review {
  private constructor(
    public readonly id: ReviewId,
    public readonly cakeId: CakeId,
    public readonly userId: string,
    public readonly rating: Rating,
    public readonly title: string,
    public readonly body: string,
    public readonly status: ReviewStatus,
    public readonly isVerifiedPurchaser: boolean,
    public readonly helpfulCount: number,
    public readonly flagCount: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  // 新規投稿: 業務ルール（title / body の長さ・rating の範囲）をすべて適用する。
  static create(input: {
    cakeId: CakeId;
    userId: string;
    rating: number;
    title: string;
    body: string;
    isVerifiedPurchaser: boolean;
  }): Review {
    assertAuthUserId(input.userId);
    const trimmedTitle = input.title.trim();
    if (trimmedTitle.length < TITLE_MIN_LENGTH) {
      throw new InvalidReviewError('タイトルは必須です');
    }
    if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      throw new InvalidReviewError(`タイトルは ${String(TITLE_MAX_LENGTH)} 文字以内です`);
    }
    const trimmedBody = input.body.trim();
    if (trimmedBody.length < BODY_MIN_LENGTH) {
      throw new InvalidReviewError('本文は必須です');
    }
    if (trimmedBody.length > BODY_MAX_LENGTH) {
      throw new InvalidReviewError(`本文は ${String(BODY_MAX_LENGTH)} 文字以内です`);
    }
    const now = new Date();
    return new Review(
      ReviewId.generate(),
      input.cakeId,
      input.userId,
      Rating.of(input.rating),
      trimmedTitle,
      trimmedBody,
      'published',
      input.isVerifiedPurchaser,
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
    cakeId: string;
    userId: string;
    rating: number;
    title: string;
    body: string;
    status: string;
    isVerifiedPurchaser: boolean;
    helpfulCount: number;
    flagCount: number;
    createdAt: Date;
    updatedAt: Date;
  }): Review {
    if (!isReviewStatus(props.status)) {
      throw new InvalidReviewError(`未知の review status: ${props.status}`);
    }
    assertAuthUserId(props.userId);
    return new Review(
      ReviewId.from(props.id),
      CakeId.from(props.cakeId),
      props.userId,
      Rating.of(props.rating),
      props.title,
      props.body,
      props.status,
      props.isVerifiedPurchaser,
      props.helpfulCount,
      props.flagCount,
      props.createdAt,
      props.updatedAt,
    );
  }
}
