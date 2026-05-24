import { describe, it, expect } from 'vitest';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from './errors';

describe('AppError 基底クラス', () => {
  it('code / status / message / details を保持する', () => {
    const err = new AppError('VALIDATION_ERROR', 'bad input', 400, [
      { field: 'price', message: '0より大きい整数を指定してください' },
    ]);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad input');
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ field: 'price', message: '0より大きい整数を指定してください' }]);
  });
});

describe('AppError サブクラスの code/status マッピング', () => {
  it.each([
    [new ValidationError('v'), 'VALIDATION_ERROR', 400],
    [new UnauthorizedError(), 'UNAUTHORIZED', 401],
    [new ForbiddenError(), 'FORBIDDEN', 403],
    [new NotFoundError(), 'NOT_FOUND', 404],
    [new ConflictError('duplicated'), 'CONFLICT', 409],
    [new RateLimitedError(10), 'RATE_LIMITED', 429],
  ] as const)('%s は code=%s status=%d', (err, code, status) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  it('ValidationError は details を保持できる', () => {
    const err = new ValidationError('入力不正', [
      { field: 'email', message: 'メール形式が不正です' },
    ]);
    expect(err.details).toHaveLength(1);
  });

  it('RateLimitedError は retryAfterSec を保持し details に Retry-After を載せる', () => {
    const err = new RateLimitedError(60);
    expect(err.retryAfterSec).toBe(60);
    expect(err.details).toEqual([{ field: 'Retry-After', message: '60' }]);
  });
});
