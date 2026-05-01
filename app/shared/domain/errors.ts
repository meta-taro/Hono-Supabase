import type { ContentfulStatusCode } from 'hono/utils/http-status';

// CLAUDE.md の統一エラーレスポンス形式に対応する。
// エラーコードは API クライアントがプログラムで分岐できるよう固定文字列で管理する。

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_SERVER_ERROR';

export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  // ContentfulStatusCode に縛ることで、不正なステータスコード生成を型レベルで防ぐ。
  // error-handler 側での as キャストも不要になる。
  public readonly status: ContentfulStatusCode;
  public readonly details?: ErrorDetail[];

  constructor(
    code: ErrorCode,
    message: string,
    status: ContentfulStatusCode,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '認証情報が不正または不足しています') {
    super('UNAUTHORIZED', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '操作する権限がありません') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = '指定されたリソースが見つかりません') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
    this.name = 'ConflictError';
  }
}
