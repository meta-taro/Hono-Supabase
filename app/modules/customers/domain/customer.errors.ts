import { ValidationError, ConflictError } from '@/shared/domain/errors';

// ドメイン例外は shared/domain/errors の AppError 体系を継承する。
// これにより error-handler が自動で 400 / 409 へマッピングしてくれる。

export class InvalidCustomerError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCustomerError';
  }
}

export class InvalidEmailError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEmailError';
  }
}

// メールアドレスの一意制約違反は CONFLICT (409) で返す。
// 「サインアップ時の二重登録」をクライアントが識別できるよう、
// VALIDATION_ERROR ではなく CONFLICT を採用する。
export class EmailAlreadyTakenError extends ConflictError {
  constructor(email: string) {
    super(`メールアドレス ${email} は既に登録されています`);
    this.name = 'EmailAlreadyTakenError';
  }
}
