import type { Order } from './order';

// "OrderPlaced" — 注文が確定したことを表すドメインイベント。
//
// 設計の現状:
//   Phase 5 段階では event bus（Cloudflare Queues / Kafka / EventEmitter 等）を持たない。
//   そのため、UseCase が logger.info(orderPlacedEvent(order), ...) として
//   構造化ログに 1 行を出力する形でイベント発行を表現する。
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
