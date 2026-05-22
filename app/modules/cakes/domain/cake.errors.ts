import { NotFoundError, PreconditionFailedError, ValidationError } from '@/shared/domain/errors';

// ドメイン例外は shared/domain/errors の AppError 体系を継承する。
// これにより error-handler が自動で 400 / 404 / 412 へマッピングしてくれる。

export class InvalidCakeError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCakeError';
  }
}

export class InvalidPriceError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPriceError';
  }
}

// 指定 ID の Cake が存在しない（404）。
export class CakeNotFoundError extends NotFoundError {
  constructor(cakeId: string) {
    super(`Cake (id=${cakeId}) が見つかりません`);
    this.name = 'CakeNotFoundError';
  }
}

// 楽観ロックの版が一致しなかった（412）。
// If-Match で提示された版以降に別の更新が入った状態。
export class CakeVersionConflictError extends PreconditionFailedError {
  constructor(cakeId: string) {
    super(`Cake (id=${cakeId}) は他の更新により変更されています。再取得してやり直してください`);
    this.name = 'CakeVersionConflictError';
  }
}
