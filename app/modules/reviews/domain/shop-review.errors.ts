import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/domain/errors';

// 店舗レビュー固有のドメイン例外。shared/domain/errors の AppError 体系を継承し、
// error-handler が自動で 400 / 403 / 404 / 409 へマッピングする。
// rating の検証は cakes レビューと共通の Rating VO（InvalidRatingError）を再利用するため、
// ここでは「店舗レビュー本体（title / body / userId）」と「重複投稿」の 2 つだけ定義する。

export class InvalidShopReviewError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShopReviewError';
  }
}

// 指定 ID の ShopReview が存在しない（404）。
export class ShopReviewNotFoundError extends NotFoundError {
  constructor(reviewId: string) {
    super(`ShopReview (id=${reviewId}) が見つかりません`);
    this.name = 'ShopReviewNotFoundError';
  }
}

// 「自分のレビューには役立った投票を付けられない」等の権限拒否で共通利用する（403）。
export class ShopReviewForbiddenError extends ForbiddenError {
  constructor(message: string) {
    super(message);
    this.name = 'ShopReviewForbiddenError';
  }
}

// 同一 user が既に published / hidden の店舗レビューを持つ（409）。
// removed 状態は再投稿可とみなすため、その場合はこの例外は飛ばない。
export class ShopReviewAlreadyExistsError extends ConflictError {
  constructor(userId: string) {
    super('この店舗には既にレビューを投稿しています');
    this.name = 'ShopReviewAlreadyExistsError';
    // userId は機微情報なのでメッセージには含めない（ログ側で構造化フィールドに残す）。
    void userId;
  }
}
