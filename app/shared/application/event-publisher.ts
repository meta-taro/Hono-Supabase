import type { WebhookEvent } from '@/shared/domain/webhook-event';

// ---------------------------------------------------------------------------
// EventPublisher port（Phase 10 Step 7）
//
//   役割:
//     - ドメインイベント（OrderPlaced 等）を「外部購読者」に通知する抽象。
//     - publish() は同期パスでイベント発火を受理する責任を持ち、配信そのものは
//       実装の裁量でバックグラウンドに逃がしてよい（Workers では ctx.waitUntil、
//       Node では Promise の fire-and-forget）。
//
//   なぜ port をここ（shared/application）に置くか:
//     - 発行側（orders/application/place-order.usecase）と購読側（webhooks）の
//       どちらの bounded context にも属さない橋渡しなので shared に置く
//     - place-order.usecase は EventPublisher だけを知り、Subscription 実装や
//       HTTP 配信の詳細は知らない（依存逆転）
//     - テスト経路では NoopEventPublisher を渡して副作用を完全に切れる
//
//   throw 規約:
//     - publish() は失敗してもユースケース（注文確定）を巻き戻さない方が望ましいが、
//       実装に判断を委ねる。今回の WebhookEventPublisher は subscription 取得失敗を
//       warn ログに留めて throw しない実装（= 注文確定は守る）。
// ---------------------------------------------------------------------------

export interface EventPublisher {
  publish(event: WebhookEvent): Promise<void>;
}

// テスト / 最小経路用の no-op 実装。
//   - place-order.usecase の単体テストで「副作用ゼロの publisher」を注入するために使う
//   - 本番経路では WebhookEventPublisher を組み立てて使う
export const NoopEventPublisher: EventPublisher = {
  publish: () => Promise.resolve(),
};
