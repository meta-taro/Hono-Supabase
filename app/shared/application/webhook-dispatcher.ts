import type { WebhookEvent } from '@/shared/domain/webhook-event';

// ---------------------------------------------------------------------------
// WebhookDispatcher port（Phase 10 Step 7）
//
//   役割:
//     - 単一の delivery を「URL + secret」に向けて HTTP POST する責任を負う
//     - HMAC-SHA256 で署名を付け、タイムアウトを掛け、結果を { kind: 'succeeded' } /
//       { kind: 'failed', message } のいずれかで返す
//     - retry スケジュールの計算 / DB 更新は呼び出し側（dispatch-pending-deliveries）が行う
//       （dispatcher 自身は「1 回の HTTP POST」だけに集中させる責任分離）
//
//   なぜ shared/application に置くか:
//     - 配信戦略は webhooks コンテキスト内に閉じても良い責務だが、
//       「http で送る + 署名する」のは横断的な関心事であり、
//       将来別の配信先（queue 等）に切り替える可能性も小さいので shared に置いて差し支えない。
// ---------------------------------------------------------------------------

export interface DispatchTarget {
  url: string;
  secret: string;
}

export type DispatchResult = { kind: 'succeeded' } | { kind: 'failed'; message: string };

export interface WebhookDispatcher {
  deliver(event: WebhookEvent, target: DispatchTarget): Promise<DispatchResult>;
}
