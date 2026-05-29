// ---------------------------------------------------------------------------
// Webhook 配信用 HMAC-SHA256 署名ヘルパ（Phase 10 Step 7）
//
//   形式（Stripe スタイル）:
//     X-Webhook-Signature: t=<unix_seconds>,v1=<hex>
//
//     - t  : 配信時刻（UNIX 秒）。replay 攻撃検知のため受信側で許容差分をチェックする想定
//     - v1 : signed_payload = `${t}.${raw_body}` を HMAC-SHA256(secret) した結果（hex）
//
//   なぜ Web Crypto なのか:
//     CLAUDE.md の Workers 互換性方針により node:crypto を import 不可。
//     crypto.subtle は Workers / Node 18+ / Edge runtime いずれでも動くため
//     ランタイム共通の実装にできる。
//
//   なぜ raw body を渡す前提なのか:
//     JSON 化のキー順序差で署名が変わると、クライアント側の verify が落ちる。
//     dispatcher が JSON.stringify(payload) した結果をそのまま渡し、署名計算と
//     fetch body 送信で同じ文字列を使うことで一致を保証する。
// ---------------------------------------------------------------------------

const toHex = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let out = '';
  for (const byte of view) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
};

// signed_payload を HMAC-SHA256 で署名し hex 文字列にする。
//   secret は文字列のまま UTF-8 バイト列にして key として使う（Stripe / GitHub と同じ慣例）。
const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(signature);
};

// 配信ヘッダ用に組み立てた文字列を返す。
//   t は呼び出し側で固定（テストでは差し替え可能、本番は Math.floor(Date.now()/1000)）。
export const buildWebhookSignatureHeader = async (params: {
  secret: string;
  rawBody: string;
  timestampSec: number;
}): Promise<string> => {
  const signedPayload = `${String(params.timestampSec)}.${params.rawBody}`;
  const v1 = await hmacSha256Hex(params.secret, signedPayload);
  return `t=${String(params.timestampSec)},v1=${v1}`;
};

// 32 バイトのランダム値を hex（64 文字）で返す。
//   crypto.subtle ではなく getRandomValues を使う（importKey 不要）。
//   webhook_subscriptions.secret 列の長さ制約 32〜256 を満たす（64 文字）。
export const generateWebhookSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
};
