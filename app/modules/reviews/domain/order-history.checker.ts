// 「ユーザーが店舗で注文したことがあるか（利用実績があるか）」を判定する port。
//
// 設計判断:
//   - reviews コンテキストから orders コンテキストの Order Entity を直接 import するのは
//     「コンテキスト間の直接参照禁止」（CLAUDE.md）に違反する。
//   - そのため interface を reviews/domain 側に切り、実装（infrastructure）が orders
//     を SQL（has_ordered RPC）で確認する形にする。orders コンテキスト側の repository も使わない。
//   - 店舗レビューは cake を問わないため、cakes レビュー側の VerifiedPurchaserChecker と違い
//     cakeId を取らず authUserId だけで「PLACED 注文が 1 件でもあるか」を判定する。
//   - shop-review 集約は「投稿時点で確かに利用客だった」事実をスナップショットして保持する
//     ため、判定回数は「POST 時 1 回」のみ。read 経路では呼ばない。
//
// authUserId は Supabase auth.users.id（注文者 / レビュー投稿者を結ぶキー）。
export interface OrderHistoryChecker {
  hasOrdered(authUserId: string): Promise<boolean>;
}
