import type { WebhookEvent } from '@/shared/domain/webhook-event';
import type { WebhookDelivery } from './webhook-delivery';

// ---------------------------------------------------------------------------
// WebhookDelivery Repository インターフェース
//
//   ライフサイクル:
//     1. enqueue   : 新規 pending 行を INSERT。UNIQUE(event_id, subscription_id) 衝突時は null。
//     2. listDue   : リクエスト駆動 dispatcher が「retry 可能な配信」を時刻順に取り出す。
//     3. markSucceeded / markFailed : 配信結果を反映。markFailed は attempts++ と
//                                      next_retry_at の計算を repo 側に任せず application 層で計算する
//                                      （ドメインロジックは domain で持つ＝ nextRetryDelayMs）。
//     4. listBySubscription : 管理 API の「履歴一覧」。keyset ページネーション。
// ---------------------------------------------------------------------------

export interface EnqueueDeliveryInput {
  event: WebhookEvent;
  subscriptionId: string;
}

export interface ListDueDeliveriesParams {
  // now 以下の next_retry_at を持つ pending/failed 行が対象。
  now: Date;
  // 1 リクエストで何件まで拾うか。
  limit: number;
}

// dispatcher が markSucceeded / markFailed を呼ぶときに必要な「サブスクリプションの url+secret」も
// 一緒に欲しいケースが多いので、対になる shape を別途用意する。
// 実装側は join するか別 SELECT するかは自由。
export interface DueDelivery {
  delivery: WebhookDelivery;
  url: string;
  secret: string;
}

export interface ListDeliveriesBySubscriptionCursor {
  createdAt: string;
  id: string;
}

export interface ListDeliveriesBySubscriptionParams {
  subscriptionId: string;
  limit: number;
  after?: ListDeliveriesBySubscriptionCursor;
}

export interface WebhookDeliveryPage {
  deliveries: WebhookDelivery[];
  nextCursor: ListDeliveriesBySubscriptionCursor | null;
}

export interface MarkFailedInput {
  // 失敗時に保存する直近エラー（HTTP status / 例外メッセージ）。
  errorMessage: string;
  // 次回 retry 時刻。null なら dead 化（attempts=MAX_ATTEMPTS 到達）。
  nextRetryAt: Date | null;
}

export interface WebhookDeliveryRepository {
  enqueue(input: EnqueueDeliveryInput): Promise<WebhookDelivery | null>;
  listDue(params: ListDueDeliveriesParams): Promise<DueDelivery[]>;
  markSucceeded(deliveryId: string, succeededAt: Date): Promise<void>;
  markFailed(deliveryId: string, input: MarkFailedInput): Promise<void>;
  listBySubscription(params: ListDeliveriesBySubscriptionParams): Promise<WebhookDeliveryPage>;
}
