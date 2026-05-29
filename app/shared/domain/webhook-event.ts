// ---------------------------------------------------------------------------
// 横断ドメインイベント定義（Phase 10 Step 7）
//
//   コンテキスト跨ぎを防ぐため、webhooks モジュールから orders モジュールの
//   domain を import することは禁止（CLAUDE.md の DDD-lite 依存ルール）。
//   そのため「どのコンテキストでも参照できる pure data 型」をここに置き、
//   - orders/application は WebhookEvent shape にデータを詰めて EventPublisher に渡す
//   - webhooks/infrastructure は受け取って配信ペイロードに変換する
//   という双方向参照を排した一方向経路を確立する。
//
//   なぜ shared に置くか:
//     event は本来 publisher（orders）側のものだが、event bus / webhooks は
//     「型を知っている購読者」になるため、両者から参照可能な中立 layer に置くしかない。
//     CLAUDE.md でも OrderPlaced ドメインイベントは orders 側に置きつつ、
//     webhook 配信用の DTO は shared に置く方針（コンテキスト跨ぎ禁止と整合）。
//
//   なぜ class ではなく pure data か:
//     - シリアライズ可能（JSON 化して queue / DB / HTTP に送れる）
//     - 振る舞いを持たないため domain ロジックの混入を防げる（webhooks 内に閉じる）
//     - 同型データを domain Entity から生成する factory（toOrderPlacedWebhookEvent）は
//       orders/domain 側に置く（=「発火する側」が DTO 化を担う）
// ---------------------------------------------------------------------------

// 配信ペイロードに載るアイテム形（注文明細 1 行）。
export interface WebhookOrderItem {
  cake_id: string;
  quantity: number;
  unit_price: number;
}

// order.placed 用の data ペイロード。配信本文の `data` フィールドにそのまま入る。
export interface OrderPlacedEventData {
  order_id: string;
  customer_id: string;
  items: WebhookOrderItem[];
  total_amount: number;
}

// 将来 cake.created 等を増やすときは type を union 拡張する形で対応する。
//   - event_id は UUID v4。EventPublisher が deliveries の UNIQUE 制約に使う。
//   - occurred_at は ISO 8601 UTC。発火時刻を固定スナップショットする（retry 時も同値）。
export type WebhookEventType = 'order.placed';

export interface WebhookEvent {
  event_id: string;
  event_type: WebhookEventType;
  occurred_at: string;
  data: OrderPlacedEventData;
}
