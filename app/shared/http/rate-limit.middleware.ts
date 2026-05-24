import type { Context, MiddlewareHandler } from 'hono';
import { RateLimitedError } from '@/shared/domain/errors';
import type { AppEnv } from '@/shared/http/request-context';
import type { RateLimiter } from '@/shared/http/rate-limiter';

// ---------------------------------------------------------------------------
// Rate Limit ミドルウェア（Phase 10 Step 5）
//
//   RateLimiter port を「リクエストごとに 1 回 limit() を呼ぶ Hono ミドルウェア」に
//   仕立てる factory。key 戦略は呼び出し側が KeyResolver で選ぶ。
//
//   失敗（success=false）時の戦略:
//     RateLimitedError(retryAfterSec) を throw → error-handler が
//     429 + Retry-After ヘッダ + 統一エラー本文（{ error: { code: 'RATE_LIMITED', ... }}）に
//     変換する。middleware では HTTP レスポンスを直接組み立てない（責務分離）。
//
//   retryAfterSec の出どころ:
//     Workers Rate Limiting binding の limit() は { success } のみで残り時間が返らないため、
//     ここでは「紐づく period（10 or 60）」を最悪値として渡す。実装的には wrangler.toml の
//     simple.period と完全一致するように呼び出し側が設定する（composition-root or bootstrap）。
// ---------------------------------------------------------------------------

export type KeyResolver = (c: Context<AppEnv>) => string;

// IP のみ（未認証エンドポイント用）。
//   `cf-connecting-ip` は Cloudflare が改ざん不可で付与するため Workers 環境では常に存在。
//   ローカル wrangler dev やテストで欠落するケースは 'anonymous' に落とす（攻撃面は小さい）。
//   ip: プレフィックスで user key と衝突しないようにする。
export const ipKey: KeyResolver = (c) => `ip:${c.req.header('cf-connecting-ip') ?? 'anonymous'}`;

// 認証済みなら user、未認証フォールバックで IP（認証必須ルートでも guard 前に通る可能性
// を考慮）。同一 user が複数 IP を使っても本人にだけ限度を返す挙動が主。
export const userOrIpKey: KeyResolver = (c) => {
  const userId = c.get('user')?.id;
  if (userId) return `user:${userId}`;
  return `ip:${c.req.header('cf-connecting-ip') ?? 'anonymous'}`;
};

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  // wrangler.toml の [ratelimits.simple] の period（10 or 60）と一致させる。
  // 429 時に Retry-After ヘッダへ転写される。
  retryAfterSec: number;
  resolveKey: KeyResolver;
}

export const createRateLimitMiddleware = (
  options: RateLimitMiddlewareOptions,
): MiddlewareHandler<AppEnv> => {
  const { limiter, retryAfterSec, resolveKey } = options;
  return async (c, next) => {
    const key = resolveKey(c);
    const { success } = await limiter.limit({ key });
    if (!success) {
      throw new RateLimitedError(retryAfterSec);
    }
    await next();
  };
};

// limiter が未注入（=Workers binding 未宣言 / Node 起点）のケース用の素通しミドルウェア。
// bootstrap 側で「binding あり → createRateLimitMiddleware」「無し → noopRateLimit」を選ぶ。
export const noopRateLimitMiddleware: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};

// ---------------------------------------------------------------------------
// restrictToMethods: 指定 method のときだけ内側 mw を呼び、それ以外は next() に素通し。
//
// 理由:
//   Hono の `router.use(path, mw)` は method 区別がないので、`GET /` と `POST /` のように
//   同じパスに異なる method がぶら下がるケースで「POST にだけ authWrite を効かせる」が
//   素直に書けない（GET にも乗ってしまう）。OpenAPIHono を使っているため `router.get(path, mw)`
//   のように method 限定 use を組み合わせるとルーティング表が複雑になるため、汎用ラッパで
//   method 判定を mw 側に内包する。
//
// 設計判断:
//   - rate-limit に限らず使い回せる汎用ロジックだが、現状のユースケースは Step 5 のみのため
//     ここ（rate-limit.middleware.ts）に同居させる。将来別用途で必要になったら shared/http
//     の独立ファイルに切り出す。
// ---------------------------------------------------------------------------
export const restrictToMethods =
  (methods: ReadonlyArray<string>, mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!methods.includes(c.req.method)) {
      return next();
    }
    return mw(c, next);
  };
