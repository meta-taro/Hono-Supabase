import type { Order } from './order';
import type { WebhookEvent } from '@/shared/domain/webhook-event';

// "OrderPlaced" — 注文が確定したことを表すドメインイベント。
//
// 設計の現状:
//   Phase 5 段階では event bus（Cloudflare Queues / Kafka / EventEmitter 等）を持たない。
//   そのため、UseCase が logger.info(orderPlacedEvent(order), ...) として
//   構造化ログに 1 行を出力する形でイベント発行を表現する。
//   Phase 10 Step 7 で EventPublisher port が入り、こちらの DTO（OrderPlacedEvent）は
//   引き続き構造化ログ専用、外部 webhook 配信用には toOrderPlacedWebhookEvent() で
//   shared/domain の WebhookEvent shape に変換する（外部契約 ≠ 内部ログの分離）。
//
// なぜ専用クラスを設けるのか:
//   - 「ログ専用」と書いてしまうとコードが副作用ログ呼び出しに化ける
//   - 将来 event bus に差し替えるとき、event 形状の互換性が崩れないよう
//     データ部分（type / orderId / customerId / totalAmount / itemCount / placedAt）を
//     型として固定する。
//   - シリアライズ可能（Pure Data）にしている = 別プロセス / 別サーバーへ送れる。
export interface OrderPlacedEvent {
  readonly type: 'OrderPlaced';
  readonly orderId: string;
  readonly customerId: string;
  readonly totalAmount: number;
  readonly itemCount: number;
  readonly placedAt: string; // ISO 8601 (UTC)
}

export const orderPlacedEvent = (order: Order): OrderPlacedEvent => ({
  type: 'OrderPlaced',
  orderId: order.id.value,
  customerId: order.customerId.value,
  totalAmount: order.totalAmount(),
  itemCount: order.items.length,
  placedAt: order.placedAt.toISOString(),
});

// Order Aggregate → 外部 webhook 配信用 DTO 変換。
//
// 「発火する側（orders）が DTO 化を担う」方針:
//   - WebhookEvent shape は shared/domain に置き webhooks コンテキストが受け取る
//   - cakeId / customerId など UUID の snake_case 化はここに閉じる
//     （webhooks 側は domain の VO や Entity を直接知らずに済む = 依存方向を保つ）
//
// event_id は配信側 deliveries テーブルの UNIQUE(event_id, subscription_id) の
//   左辺として使う。1 回の注文確定で全 subscription への配信を「同一 event」と扱うため
//   ここで 1 つの UUID を発行し、複数 subscription 分の delivery 行に同じ値を載せる。
//   crypto.randomUUID() は Web Crypto API（Node 19+ / Workers / ブラウザ共通）。
export const toOrderPlacedWebhookEvent = (order: Order): WebhookEvent => ({
  event_id: crypto.randomUUID(),
  event_type: 'order.placed',
  occurred_at: order.placedAt.toISOString(),
  data: {
    order_id: order.id.value,
    customer_id: order.customerId.value,
    items: order.items.map((item) => ({
      cake_id: item.cakeId.value,
      quantity: item.quantity.value,
      unit_price: item.unitPrice,
    })),
    total_amount: order.totalAmount(),
  },
});
