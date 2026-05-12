import { ValidationError } from '@/shared/domain/errors';

// ドメイン例外は shared/domain/errors の AppError 体系を継承する。
// これにより error-handler が自動で 400 / 404 へマッピングしてくれる。

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
