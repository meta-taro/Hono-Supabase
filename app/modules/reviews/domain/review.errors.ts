import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/domain/errors';

// ドメイン例外は shared/domain/errors の AppError 体系を継承する。
// これにより error-handler が自動で 400 / 403 / 404 へマッピングしてくれる。

export class InvalidReviewError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewError';
  }
}

export class InvalidRatingError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRatingError';
  }
}

// 指定 ID の Review が存在しない（404）。
export class ReviewNotFoundError extends NotFoundError {
  constructor(reviewId: string) {
    super(`Review (id=${reviewId}) が見つかりません`);
    this.name = 'ReviewNotFoundError';
  }
}

// 「他人のレビューは触れない」を含む書き換え系の権限拒否で共通利用する（403）。
export class ReviewForbiddenError extends ForbiddenError {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewForbiddenError';
  }
}

// 同一 user が同一 cake に対して既に published / hidden のレビューを持つ（409）。
// removed 状態は再投稿可とみなすため、その場合はこの例外は飛ばない。
export class ReviewAlreadyExistsError extends ConflictError {
  constructor(cakeId: string, userId: string) {
    super(`このケーキ (id=${cakeId}) には既にレビューを投稿しています`);
    this.name = 'ReviewAlreadyExistsError';
    // userId は機微情報なのでメッセージには含めない（ログ側で構造化フィールドに残す）。
    void userId;
  }
}
