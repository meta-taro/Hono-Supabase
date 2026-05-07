import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '@/shared/http/env';
import { UnauthorizedError, ForbiddenError } from '@/shared/domain/errors';
import type {
  AppEnv,
  AppVariables,
  AppRole,
  AuthUser,
} from '@/shared/http/request-context';

// ---------------------------------------------------------------------------
// Supabase Auth の JWT を JWKS（公開鍵）で検証するミドルウェア群。
//
// なぜ JWKS なのか:
//   - サーバー側で Supabase の auth エンドポイントに HTTP 往復させない（p99 安定）
//   - 公開鍵は一度取得すればキャッシュされる（jose の createRemoteJWKSet が自動）
//   - Cloudflare Workers と相性が良い（fetch ベースの Web 標準実装）
//
// 検証する claim:
//   - issuer:  https://<project>.supabase.co/auth/v1
//   - audience: 'authenticated'（Supabase の標準）
//   - exp/nbf: jose が標準で検証
// ---------------------------------------------------------------------------

const SUPABASE_JWKS_PATH = '/auth/v1/.well-known/jwks.json';
const BEARER_PREFIX = 'Bearer ';

// JWKS は Env ごと（= Supabase プロジェクトごと）に 1 インスタンスだけ作って再利用する。
// jose がキー回転に追従する内部キャッシュを持つので、毎リクエスト作り直さない。
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const getJwks = (env: Env) => {
  const url = `${env.SUPABASE_URL}${SUPABASE_JWKS_PATH}`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
};

const extractRole = (payload: JWTPayload): AppRole => {
  const appMetadata = payload['app_metadata'] as { role?: string } | undefined;
  return appMetadata?.role === 'admin' ? 'admin' : 'authenticated';
};

const toAuthUser = (payload: JWTPayload): AuthUser | null => {
  if (typeof payload.sub !== 'string') {
    return null;
  }
  return {
    id: payload.sub,
    email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
    role: extractRole(payload),
  };
};

// ---------------------------------------------------------------------------
// optional 認証ミドルウェア
//   - Authorization 不在は許容（c.var.user は undefined のまま）
//   - JWT があれば検証し、成功時のみ c.var.user / c.var.jwt をセット
//   - 失敗（不正な JWT）は黙ってスキップ。後段 requireAuth が 401 を投げる責務
//
//   このミドルウェアをグローバルに 1 つ通すことで、
//   公開エンドポイント（GET /v1/cakes、POST /v1/customers）でも
//   「JWT があれば user 情報を載せる」挙動になり、
//   sb（per-request クライアント）に Authorization ヘッダを乗せられる。
// ---------------------------------------------------------------------------
export const createOptionalAuthMiddleware = (
  env: Env,
): MiddlewareHandler<AppEnv> => {
  const jwks = getJwks(env);
  const issuer = `${env.SUPABASE_URL}/auth/v1`;

  return async (c, next) => {
    const auth = c.req.header('Authorization');
    if (auth?.startsWith(BEARER_PREFIX)) {
      const token = auth.slice(BEARER_PREFIX.length).trim();
      if (token.length > 0) {
        try {
          const { payload } = await jwtVerify(token, jwks, {
            issuer,
            audience: 'authenticated',
          });
          const user = toAuthUser(payload);
          if (user) {
            c.set('user', user);
            c.set('jwt', token);
          }
        } catch {
          // 不正な JWT は無視（公開エンドポイントなら通したい）。
          // 認証が必須のルートでは requireAuth が後段で 401 を投げる。
        }
      }
    }
    await next();
  };
};

// ---------------------------------------------------------------------------
// requireAuth: c.var.user が必須であることを保証するゲート
//   optionalAuthMiddleware の後に連鎖して使う。
// ---------------------------------------------------------------------------
export const requireAuth = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (!c.get('user')) {
      throw new UnauthorizedError('認証が必要です');
    }
    await next();
  };
};

// ---------------------------------------------------------------------------
// requireAdmin: app_metadata.role = 'admin' を強制するゲート
//   requireAuth の後に連鎖して使う前提（user 不在は 401）。
// ---------------------------------------------------------------------------
export const requireAdmin = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      throw new UnauthorizedError('認証が必要です');
    }
    if (user.role !== 'admin') {
      throw new ForbiddenError('この操作には管理者権限が必要です');
    }
    await next();
  };
};

// ---------------------------------------------------------------------------
// per-request Supabase クライアント注入ミドルウェア
//   - 認証済みなら anon キー + Authorization ヘッダで RLS が効くクライアントを作る
//   - 未認証ルートでも anon キーのみのクライアントを c.var.sb に積む
//   （未認証経路でも DB アクセスする可能性があるため、必ずセットする）
// ---------------------------------------------------------------------------
const SERVER_AUTH_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

export const createRequestSupabaseMiddleware = (
  env: Env,
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const jwt = c.get('jwt');
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      ...SERVER_AUTH_OPTIONS,
      global: jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : undefined,
    });
    c.set('sb', sb);
    await next();
  };
};

// ---------------------------------------------------------------------------
// テスト用: 固定ユーザーを c.var に積むだけのフェイクミドルウェア。
//   統合テストでは JWKS を叩かず、決め打ちのユーザーで素通りさせる。
//   composition-root の authMiddleware パラメータに差し替えて使う。
//   user に null を渡すと「未認証扱い」をシミュレートできる。
// ---------------------------------------------------------------------------
export const createFakeAuthMiddleware = (
  user: AuthUser | null,
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (user) {
      c.set('user', user);
    }
    await next();
  };
};

export type { AppVariables };
