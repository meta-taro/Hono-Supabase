import type { WebhookEvent } from '@/shared/domain/webhook-event';
import type {
  DispatchResult,
  DispatchTarget,
  WebhookDispatcher,
} from '@/shared/application/webhook-dispatcher';
import { buildWebhookSignatureHeader } from '@/shared/http/webhook-signature';

// ---------------------------------------------------------------------------
// FetchWebhookDispatcher
//
//   HTTP fetch + HMAC 署名で 1 件の配信を行う具象実装。
//
//   設計判断:
//     - timeoutMs（既定 10s）を AbortController で強制。Workers の subrequest はデフォルト
//       30s 程度だが、配信先の不調で全体が詰まらないよう短めに設定する。
//     - 2xx/3xx → succeeded、それ以外 → failed として上位に返す。throw はしない
//       （dispatch-pending-deliveries が retry スケジュール反映を担うため）。
//     - 受信側の verification を簡素化するため、Content-Type は application/json 固定で
//       JSON.stringify(event) をそのまま body にする（署名計算と同じ文字列）。
//
//   ヘッダ:
//     X-Webhook-Event-Id        : event.event_id（クライアント側で冪等性に使える）
//     X-Webhook-Event-Type      : event.event_type
//     X-Webhook-Signature       : Stripe スタイル "t=<unix>,v1=<hex>"
//     Content-Type              : application/json; charset=UTF-8
// ---------------------------------------------------------------------------

export interface FetchWebhookDispatcherOptions {
  // 注入可能な fetch 実装。Workers では globalThis.fetch を、テストでは fake fetch を渡す。
  fetcher: typeof fetch;
  // 配信タイムアウト（ミリ秒）。既定 10000ms。
  timeoutMs?: number;
  // 配信時刻（テストで固定したいケース用）。省略時は Date.now()。
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export const createFetchWebhookDispatcher = (
  options: FetchWebhookDispatcherOptions,
): WebhookDispatcher => {
  const { fetcher, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = options;
  return {
    deliver: async (event: WebhookEvent, target: DispatchTarget): Promise<DispatchResult> => {
      const rawBody = JSON.stringify(event);
      const timestampSec = Math.floor(now().getTime() / 1000);
      const signature = await buildWebhookSignatureHeader({
        secret: target.secret,
        rawBody,
        timestampSec,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const res = await fetcher(target.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Webhook-Event-Id': event.event_id,
            'X-Webhook-Event-Type': event.event_type,
            'X-Webhook-Signature': signature,
          },
          body: rawBody,
          signal: controller.signal,
        });
        if (res.status >= 200 && res.status < 400) {
          return { kind: 'succeeded' };
        }
        return { kind: 'failed', message: `HTTP ${String(res.status)}` };
      } catch (e) {
        // AbortError（timeout）/ ネットワーク不到達 / DNS 失敗 すべて failed に倒す。
        const message = e instanceof Error ? e.message : 'unknown fetch error';
        return { kind: 'failed', message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
