import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from 'hono';
import { ValidationError } from '@/shared/domain/errors';
import type { AppEnv } from './request-context';

// ---------------------------------------------------------------------------
// OpenAPIHono のデフォルト挙動を CLAUDE.md 統一エラーレスポンス形式に合わせるラッパー。
//
// 問題:
//   素の `new OpenAPIHono()` は Zod 検証失敗時に独自形式
//   （{ success: false, error: { issues: [...] } } 風）の 400 を返す。
//   これは CLAUDE.md の統一形式
//   （{ error: { code: 'VALIDATION_ERROR', message, details: [...] } }）と食い違う。
//
// 解:
//   defaultHook で検証失敗を捕まえ、ValidationError として throw する。
//   error-handler がこれを 400 + 統一形式に変換してくれる。
//
// 効果:
//   すべてのサブルーターで Zod 検証エラー / ドメイン例外が同じ JSON 形に整う。
//   API クライアントは error.code だけ見れば種別判定できる。
// ---------------------------------------------------------------------------
// Variables / Bindings 共有のため、デフォルトでは AppEnv を流す。
// テスト等で別 Env を使いたければ generic で上書きできる。
export const createOpenAPIHono = <E extends Env = AppEnv>(): OpenAPIHono<E> => {
  return new OpenAPIHono<E>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new ValidationError(
          'リクエストパラメータが不正です',
          result.error.issues.map((issue) => ({
            // path は ['body', 'price'] のような配列。最後の要素がフィールド名。
            // 配列が空（root レベルのエラー）の場合は '(root)' に fallback。
            field: issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : '(root)',
            message: issue.message,
          })),
        );
      }
    },
  });
};
