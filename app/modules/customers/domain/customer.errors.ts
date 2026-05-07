import { ValidationError, ConflictError, NotFoundError } from '@/shared/domain/errors';

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

// signUp 直後に handle_new_user トリガが customers 行を作る前提だが、
// 何らかの理由（トリガ未適用 / RLS によるアプリ視点での 0 件）で
// findByAuthUserId が null を返した場合に投げる。
// 本来は内部矛盾（500 相当）だが、Phase 6 の運用では「該当 customer が見つからない」
// = NOT_FOUND のほうが API 利用者に伝わるため 404 系として扱う。
export class CustomerNotFoundError extends NotFoundError {
  constructor(message = '対象の顧客が見つかりません') {
    super(message);
    this.name = 'CustomerNotFoundError';
  }
}

// Supabase Auth の signUp が email 重複等で失敗したケースを
// EmailAlreadyTakenError と同じ 409 として扱う。
// （メッセージ変換は infrastructure のアダプタで行う）
export class SignUpFailedError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'SignUpFailedError';
  }
}
