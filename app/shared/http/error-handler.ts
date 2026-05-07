import type { ErrorHandler } from 'hono';
import { AppError } from '@/shared/domain/errors';
import type { AppLogger } from '@/shared/infrastructure/logger';

// ---------------------------------------------------------------------------
// errorHandler は logger を引数で受ける factory に変更（Phase 7）。
//
// 変更理由:
//   - 旧実装は `import { logger } from '@/shared/infrastructure/logger'` で
//     モジュール評価時にできあがっていた pino インスタンスを直叩きしていた
//   - これが Cloudflare Workers の bundle に載ると、評価時に process.env を
//     読みにいって `process is not defined` でクラッシュする
//   - factory 化することで、ランタイム別に組み立てた logger（Node=pino /
//     Workers=console-based）を bootstrap → createApp 経由で渡せる
// ---------------------------------------------------------------------------

export const createErrorHandler = (logger: AppLogger): ErrorHandler => {
  return (err, c) => {
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
};
