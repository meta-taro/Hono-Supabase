import { ConflictError, ValidationError } from '@/shared/domain/errors';

// 店舗レビュー固有のドメイン例外。shared/domain/errors の AppError 体系を継承し、
// error-handler が自動で 400 / 409 へマッピングする。
// rating の検証は cakes レビューと共通の Rating VO（InvalidRatingError）を再利用するため、
// ここでは「店舗レビュー本体（title / body / userId）」と「重複投稿」の 2 つだけ定義する。

export class InvalidShopReviewError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShopReviewError';
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
