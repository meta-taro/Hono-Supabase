import type { ErrorHandler } from 'hono';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    // 業務エラーは warn レベル。method/path をセットで残すことで
    // 同一パスの GET/POST を障害調査時に区別できるようにする。
    logger.warn(
      { err, code: err.code, method: c.req.method, path: c.req.path },
      'Application error',
    );
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
      err.status,
    );
  }

  // 想定外の例外はスタックトレース付きで error レベルで記録する。
  logger.error(
    { err, method: c.req.method, path: c.req.path },
    'Unhandled internal error',
  );
  return c.json(
    {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '予期しないエラーが発生しました',
      },
    },
    500,
  );
};
