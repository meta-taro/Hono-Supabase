import type { ContentfulStatusCode } from 'hono/utils/http-status';

// CLAUDE.md の統一エラーレスポンス形式に対応する。
// エラーコードは API クライアントがプログラムで分岐できるよう固定文字列で管理する。

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'PRECONDITION_REQUIRED'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED'
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

// 楽観ロック（If-Match）の前提条件が崩れたときに使う。
//   - PreconditionFailedError(412): If-Match で提示された版が現在の版と一致しない
//     （= 別の更新が割り込んだ。RFC 7232 §3.1）。クライアントは再取得してやり直す。
//   - PreconditionRequiredError(428): 更新系で If-Match が必須なのに付いていない
//     （RFC 6585 §3）。lost update を構造的に防ぐため、無条件上書きを拒否する。
export class PreconditionFailedError extends AppError {
  constructor(message = 'リソースが他の更新により変更されています') {
    super('PRECONDITION_FAILED', message, 412);
    this.name = 'PreconditionFailedError';
  }
}

export class PreconditionRequiredError extends AppError {
  constructor(message = 'If-Match ヘッダが必要です') {
    super('PRECONDITION_REQUIRED', message, 428);
    this.name = 'PreconditionRequiredError';
  }
}

// Idempotency-Key middleware（Phase 10 Step 6）の 3 種類の失敗状態。
//   - IdempotencyKeyRequiredError(400): ヘッダ欠落 / 空 / 長さ超過 / 非 ASCII 印字可能。
//       クライアントは「適切な Idempotency-Key を付けて再送」できる。
//   - IdempotencyInProgressError(409): 同じ key + owner + scope で in_progress の予約あり。
//       1 回目がまだ完了していない → クライアントはバックオフして再送する。
//   - IdempotencyKeyReusedError(422): 同じ key + owner + scope で完了済みだが body が異なる。
//       クライアントが key の使い回し（新規操作なのに古い key を再利用）に失敗している。
//       422 = リクエスト構文は正しいが意味的に処理不能（Stripe 流の選択）。
export class IdempotencyKeyRequiredError extends AppError {
  constructor(message: string) {
    super('IDEMPOTENCY_KEY_REQUIRED', message, 400);
    this.name = 'IdempotencyKeyRequiredError';
  }
}

export class IdempotencyInProgressError extends AppError {
  constructor(message = '同じ Idempotency-Key の処理が進行中です') {
    super('IDEMPOTENCY_IN_PROGRESS', message, 409);
    this.name = 'IdempotencyInProgressError';
  }
}

export class IdempotencyKeyReusedError extends AppError {
  constructor(message = '同じ Idempotency-Key で異なるリクエストボディが送られました') {
    super('IDEMPOTENCY_KEY_REUSED', message, 422);
    this.name = 'IdempotencyKeyReusedError';
  }
}

// Rate Limit に引っかかったときに使う（429 / RFC 6585 §4）。
//   retryAfterSec は Hono の error-handler が Retry-After ヘッダに転写する責務を負う。
//   Cloudflare Workers Rate Limiting binding の limit() 戻り値は { success } のみで
//   サーバ側に残り時間が返らないため、middleware が「適用した period（10 or 60）」を
//   そのまま retryAfterSec として渡す（=「最悪この秒数待てば必ず通る」上限値）。
export class RateLimitedError extends AppError {
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message = 'リクエスト数が上限を超えました') {
    super('RATE_LIMITED', message, 429, [{ field: 'Retry-After', message: String(retryAfterSec) }]);
    this.name = 'RateLimitedError';
    this.retryAfterSec = retryAfterSec;
  }
}
