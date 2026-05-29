import type { ErrorHandler } from 'hono';
import { AppError, RateLimitedError } from '@/shared/domain/errors';
import type { AppEnv } from '@/shared/http/request-context';
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
//
// Phase 9 Step 1:
//   c.get('logger') があれば req スコープロガーを優先する。requestId / method / path が
//   child binding として既に乗っているので、エラーログも 1 リクエスト単位で grep できる。
//   middleware 未挿入の経路（テストの最小 app 等）では引数の fallback logger を使う。
// ---------------------------------------------------------------------------

export const createErrorHandler = (fallbackLogger: AppLogger): ErrorHandler<AppEnv> => {
  return (err, c) => {
    const logger = c.get('logger') ?? fallbackLogger;

    if (err instanceof AppError) {
      // 業務エラーは warn レベル。req スコープロガーが乗っていれば requestId / method / path は
      // child binding 側で出るので、ここでは AppError 固有の code だけ追加で乗せる。
      logger.warn({ err, code: err.code }, 'Application error');
      // Rate Limit だけ HTTP 標準の Retry-After ヘッダを別途付ける（RFC 6585 §4）。
      // 統一エラー本文の details にも Retry-After は乗るが、ヘッダ経由でも読めるようにする。
      if (err instanceof RateLimitedError) {
        c.header('Retry-After', String(err.retryAfterSec));
      }
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
    logger.error({ err }, 'Unhandled internal error');
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
