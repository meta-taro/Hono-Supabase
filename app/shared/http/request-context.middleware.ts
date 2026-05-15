import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/shared/http/request-context';
import type { AppLogger } from '@/shared/infrastructure/logger';

// ---------------------------------------------------------------------------
// requestContextMiddleware
//   1 リクエストを「追える単位」にするための観測ハード（Phase 9 Step 1）。
//
//   役割:
//     1. リクエストごとに requestId を決定する
//          - X-Request-Id ヘッダがあれば採用（上流の LB / フロント / Bruno 等から伝播）
//          - 無ければ Web Crypto API の randomUUID() で生成（Workers / Node 22 共通）
//     2. base logger を child(requestId, method, path) して req スコープロガーに格上げ
//        - 以降の UseCase / error-handler はこの logger を使うことで、
//          1 リクエストで吐かれた全ログを `requestId=xxx` で grep できる
//     3. レスポンスヘッダ X-Request-Id に反射
//        - クライアントが障害報告時に貼ってもらえば即座にログ追跡できる
//
//   なぜ globalMiddlewares なのか:
//     /health もリクエスト ID を持つべき（外形監視・uptime monitor から叩かれる）。
//     /v1/* 限定だと /health が「観測の蚊帳の外」になってしまう。
//
//   なぜ自前実装なのか:
//     Hono コアの requestId middleware（hono/request-id）もあるが、本プロジェクトは
//     ロガーへの child binding と一体運用したいので独自に書く。挙動が読みやすく、
//     学習目的にも合う。
// ---------------------------------------------------------------------------

export interface RequestContextMiddlewareDeps {
  baseLogger: AppLogger;
  // requestId 生成器を差し替え可能にしておく（テストで決定論的な値を流すため）。
  // 省略時は Web Crypto API の randomUUID（Workers / Node 22 双方に組み込み済み）。
  generateId?: () => string;
}

// 受け取った X-Request-Id をそのまま反射するのは「ログ汚染攻撃」の入口になりうる
// （巨大な値・改行混入・制御文字を投入してくる）ので最小限のサニタイズをかける。
//   - 長さ上限: 128 文字（一般的な UUID / NanoID / cf-ray のいずれも余裕で収まる）
//   - 許容文字: ASCII 印字可能のうち、HTTP ヘッダで安全な subset
//     英数字 / `-` / `_` のみに絞る（slash や colon は反射時に意図しない解釈を招く）
//   - 上記を満たさなければ「無かった」扱いにして自前生成する
const INCOMING_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const sanitizeIncomingId = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!INCOMING_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
};

export const createRequestContextMiddleware = (
  deps: RequestContextMiddlewareDeps,
): MiddlewareHandler<AppEnv> => {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());

  return async (c, next) => {
    const incoming = sanitizeIncomingId(c.req.header('x-request-id'));
    const requestId = incoming ?? generateId();

    const logger = deps.baseLogger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
    });

    c.set('requestId', requestId);
    c.set('logger', logger);

    await next();

    // レスポンスヘッダに反射する。next() の後で書くのは、ハンドラ側で c.json() などにより
    // レスポンスが確定した「後」に Hono の c.res が利用可能になるため。
    c.res.headers.set('X-Request-Id', requestId);
  };
};
