import type { Context, MiddlewareHandler } from 'hono';
import {
  IdempotencyInProgressError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
} from '@/shared/domain/errors';
import type { AppEnv } from '@/shared/http/request-context';
import type {
  IdempotencyOwnerType,
  IdempotencyStore,
} from '@/shared/infrastructure/idempotency-store';

// ---------------------------------------------------------------------------
// Idempotency-Key ミドルウェア（Phase 10 Step 6）
//
//   契約:
//     - 受信ヘッダ Idempotency-Key を必須化し、同じキー + 同じ body で再送された
//       リクエストは 1 回目のレスポンスをそのまま replay する。
//     - body が違うと 422、進行中なら 409、形式不正なら 400 を返す。
//     - replay 時は `Idempotency-Replayed: true` ヘッダを付ける（観測性確保）。
//
//   スコープ分離:
//     factory に渡す scope 文字列（例: 'POST /v1/orders'）でエンドポイント単位の
//     名前空間を切る。さらに resolveOwner で owner_type / owner_id を解決し、
//     ユーザ単位 / IP 単位の隔離を担保する（CLAUDE.md の RLS と同じ多重防御の発想）。
//
//   なぜ middleware 層で完結させるか:
//     - 各 POST ハンドラに分散すると実装漏れが発生する
//     - DDD-lite の application 層に持ち込むと「HTTP 再送制御」というインフラ関心が
//       業務ロジックに混入する
//     - 構造上 presentation の手前で握り潰す責務として扱うのが素直
// ---------------------------------------------------------------------------

// クライアントが送る Idempotency-Key の形式制約。
//   - 1 〜 255 文字（DB / index の現実的上限）
//   - ASCII 印字可能（0x20-0x7E）のみ。マルチバイト混入は CDN / proxy の挙動が
//     ばらつくため明示的に弾く。Stripe / Square と同じ範囲制限。
const KEY_MAX_LENGTH = 255;
const KEY_PATTERN = /^[\x20-\x7e]+$/;

export type OwnerResolution = {
  ownerType: IdempotencyOwnerType;
  ownerId: string;
};

export type OwnerResolver = (c: Context<AppEnv>) => OwnerResolution;

// 認証済みユーザの id を owner にする。auth middleware の後に挿入する前提。
export const userOwner: OwnerResolver = (c) => {
  const userId = c.get('user')?.id;
  if (!userId) {
    // 認証必須ルートでは guard が先に弾く想定だが、保険として ip フォールバックを置く
    // （fall-through で 401 を出す方が筋だが、middleware の責務を増やしすぎないため
    //  認証エラー検知は専用ガードに任せる）。
    return { ownerType: 'ip', ownerId: c.req.header('cf-connecting-ip') ?? 'anonymous' };
  }
  return { ownerType: 'user', ownerId: userId };
};

// 未認証ルート（POST /v1/customers のサインアップ等）用。cf-connecting-ip を採用。
export const ipOwner: OwnerResolver = (c) => ({
  ownerType: 'ip',
  ownerId: c.req.header('cf-connecting-ip') ?? 'anonymous',
});

export interface IdempotencyMiddlewareOptions {
  store: IdempotencyStore;
  // エンドポイント単位の名前空間。'POST /v1/orders' のように HTTP method + path を入れる。
  scope: string;
  resolveOwner: OwnerResolver;
}

// ---------------------------------------------------------------------------
// canonical JSON 化: キーをアルファベット順にソートして文字列化する。
//   - 同じ意味のリクエスト body が JSON プロパティ順序の違いで別ハッシュにならないようにする
//   - 配列は順序に意味があるためそのまま保つ
//   - undefined / 関数等は JSON.stringify と同じく省略される
// ---------------------------------------------------------------------------
const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = canonicalize(v);
  }
  return out;
};

const toHex = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let out = '';
  // for-of で要素を直接取れば noUncheckedIndexedAccess の非 nullable 推論が効く
  // （`view[i]` インデックス参照だと undefined を含む型になり non-null assertion を要する）。
  for (const byte of view) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
};

// Web Crypto は Workers ネイティブ + Node 18+ で利用可能。pure な fetch ベースで Node 専用
// API（node:crypto）には依存しない（CLAUDE.md の Workers 互換禁止事項に整合）。
const sha256Hex = async (text: string): Promise<string> => {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toHex(digest);
};

const validateKey = (raw: string | undefined): string => {
  if (!raw) {
    throw new IdempotencyKeyRequiredError('Idempotency-Key ヘッダが必要です');
  }
  if (raw.length === 0 || raw.length > KEY_MAX_LENGTH) {
    throw new IdempotencyKeyRequiredError(
      `Idempotency-Key は 1〜${String(KEY_MAX_LENGTH)} 文字で指定してください`,
    );
  }
  if (!KEY_PATTERN.test(raw)) {
    throw new IdempotencyKeyRequiredError('Idempotency-Key は ASCII 印字可能文字のみ使用できます');
  }
  return raw;
};

// content-type に関わらず生 body 文字列を取得する。
//   - JSON 以外（form / multipart）でも一意のハッシュが取れるよう text 化する
//   - 後段の zod-openapi が c.req.json() を呼んでも Hono が再解釈できるよう
//     c.req.text() の結果は内部キャッシュされる（Hono の挙動）
const readBodyText = async (c: Context<AppEnv>): Promise<string> => {
  try {
    return await c.req.text();
  } catch {
    return '';
  }
};

const computeRequestHash = async (bodyText: string): Promise<string> => {
  if (bodyText.length === 0) {
    return sha256Hex('');
  }
  // JSON として解釈できれば canonical 化、できなければ生文字列をそのままハッシュ。
  // 比較は「同一クライアントが意味的に同じ body を再送した」ケースに合えばよい。
  // try 内では `return await` を使う必要がある（return-await ルール）— await せずに
  // Promise を返すと sha256Hex の reject を catch が捕まえられない。
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return await sha256Hex(JSON.stringify(canonicalize(parsed)));
  } catch {
    return await sha256Hex(bodyText);
  }
};

// レスポンス本文を JSON として取り出す。Hono の handler が c.json() を返した直後の
// c.res（Response 互換）を clone してから読み出すため、後段で再送出しても壊れない。
const readResponseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.clone().json();
  } catch {
    // JSON 以外のレスポンス（バイナリ等）は idempotency 対象外として未保存にする。
    // 学習プロジェクトでは POST 系は全て JSON を返す前提なので、ここに来たら設計ミス。
    return null;
  }
};

export const createIdempotencyMiddleware = (
  options: IdempotencyMiddlewareOptions,
): MiddlewareHandler<AppEnv> => {
  const { store, scope, resolveOwner } = options;

  return async (c, next) => {
    const key = validateKey(c.req.header('Idempotency-Key'));
    const { ownerType, ownerId } = resolveOwner(c);

    const bodyText = await readBodyText(c);
    const requestHash = await computeRequestHash(bodyText);

    const record = { key, ownerType, ownerId, scope, requestHash };
    const outcome = await store.tryReserve(record);

    if (outcome.kind === 'in_progress') {
      throw new IdempotencyInProgressError();
    }
    if (outcome.kind === 'mismatch') {
      throw new IdempotencyKeyReusedError();
    }
    if (outcome.kind === 'replay') {
      c.header('Idempotency-Replayed', 'true');
      // ContentfulStatusCode に縛られない汎用処理にするため Response を直接組み立てる。
      // c.json() は型レベルで status を絞ろうとして number を弾くため。
      return c.newResponse(JSON.stringify(outcome.body), outcome.status as 200, {
        'Content-Type': 'application/json; charset=UTF-8',
      });
    }

    await next();

    // ハンドラが正常に Response を組み立てたらここに来る。例外を投げていた場合は
    // error-handler が onError で別レスポンスに置き換えるが、c.res は最終 Response を
    // 指す（Hono の挙動）ので、その status / body を complete に保存する。
    const status = c.res.status;
    const body = await readResponseJson(c.res);
    await store.complete(record, { status, body });
    return undefined;
  };
};

// binding（store）未注入時の素通しミドルウェア。Node ローカル経路や最小テストで使う。
export const noopIdempotencyMiddleware: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};
