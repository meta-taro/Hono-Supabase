import type { WebhookEvent } from '@/shared/domain/webhook-event';

// ---------------------------------------------------------------------------
// WebhookDelivery Entity（1 イベント × 1 配信先の試行ログ）
//
//   状態遷移:
//     pending --配信成功-->        succeeded
//            --配信失敗 1〜5 回--> failed (next_retry_at = 指数バックオフ)
//            --配信失敗 6 回-->    dead   (next_retry_at = NULL)
//
//   なぜ Entity を残すか:
//     - DDD-lite の慣例（modules/cakes 等も Entity 経由で reconstruct している）
//     - status の不整合（'succeeded' なのに next_retry_at がある等）を 1 か所で検証できる
//     - 「次の retry スケジュール」を計算する純粋ロジックを domain に置ける
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'dead';

// 指数バックオフのスケジュール（ms 単位）。
//   試行 1 失敗  → 1 分
//   試行 2 失敗  → 5 分
//   試行 3 失敗  → 30 分
//   試行 4 失敗  → 4 時間
//   試行 5 失敗  → 24 時間
//   試行 6 失敗  → dead（次回なし）
//
// 「試行 N の失敗後に次回まで待つ秒数」のテーブル。インデックスは attempts（更新後の値）に対応。
const RETRY_DELAYS_MS: readonly number[] = [
  60 * 1000, // attempts=1
  5 * 60 * 1000, // attempts=2
  30 * 60 * 1000, // attempts=3
  4 * 60 * 60 * 1000, // attempts=4
  24 * 60 * 60 * 1000, // attempts=5
];

export const MAX_ATTEMPTS = 6;

// 「次の retry までの遅延」と「dead 化するか」を返す純関数。
//   attempts はインクリメント済みの値を渡す（=「N 回目の失敗を記録した」直後の状態）。
//   返り値が null なら dead（=これ以上 retry しない）。
export const nextRetryDelayMs = (attempts: number): number | null => {
  if (attempts >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[attempts - 1];
  return delay ?? null;
};

export class WebhookDelivery {
  private constructor(
    public readonly id: string,
    public readonly eventId: string,
    public readonly subscriptionId: string,
    public readonly eventType: string,
    public readonly payload: WebhookEvent,
    public readonly status: WebhookDeliveryStatus,
    public readonly attempts: number,
    public readonly lastError: string | null,
    public readonly nextRetryAt: Date | null,
    public readonly succeededAt: Date | null,
    public readonly createdAt: Date,
  ) {}

  // 永続化（DB or in-memory）からの復元。
  static reconstruct(props: {
    id: string;
    eventId: string;
    subscriptionId: string;
    eventType: string;
    payload: WebhookEvent;
    status: WebhookDeliveryStatus;
    attempts: number;
    lastError: string | null;
    nextRetryAt: Date | null;
    succeededAt: Date | null;
    createdAt: Date;
  }): WebhookDelivery {
    return new WebhookDelivery(
      props.id,
      props.eventId,
      props.subscriptionId,
      props.eventType,
      props.payload,
      props.status,
      props.attempts,
      props.lastError,
      props.nextRetryAt,
      props.succeededAt,
      props.createdAt,
    );
  }
}
