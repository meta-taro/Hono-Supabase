import type { CakeId } from './cake-id.vo';

// 「ユーザーがそのケーキを買ったことがあるか」を判定する port。
//
// 設計判断:
//   - reviews コンテキストから orders コンテキストの Order Entity を直接 import するのは
//     「コンテキスト間の直接参照禁止」（CLAUDE.md）に違反する。
//   - そのため interface を reviews/domain 側に切り、実装（infrastructure）が orders/order_items
//     を SQL で確認する形にする。orders コンテキスト側の repository も使わない（依存方向を切る）。
//   - reviews 集約は「投稿時点で確かに購入していた」事実をスナップショットして保持する
//     ため、判定回数は「POST 時 1 回」のみ。read 経路では呼ばない。
//
// authUserId は Supabase auth.users.id（注文者 / レビュー投稿者を結ぶキー）。
// customers.id 経由ではなく authUserId 直叩きにする理由:
//   - レビュー投稿は authUserId が決まった時点で行える（customers 行が無くてもよい）
//   - infrastructure 側で customers.auth_user_id → orders.customer_id を join するだけで判定可能
export interface VerifiedPurchaserChecker {
  hasPurchased(authUserId: string, cakeId: CakeId): Promise<boolean>;
}
