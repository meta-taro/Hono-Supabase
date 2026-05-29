import type { OrderHistoryChecker } from '@/modules/reviews/domain/order-history.checker';

// テスト用の in-memory 実装。
//   - コンストラクタで「利用実績あり」と判定する authUserId を受け取る。
//   - 既定では全件 false（=未利用）。
// 本番経路は infrastructure 層で orders テーブルを参照する別実装（has_ordered RPC）を用意する。
export class InMemoryOrderHistoryChecker implements OrderHistoryChecker {
  private readonly ordered: Set<string>;

  constructor(authUserIds: string[] = []) {
    this.ordered = new Set(authUserIds);
  }

  // 動的に利用実績を足す（テスト中に状態を変えたいケース用）。
  markOrdered(authUserId: string): void {
    this.ordered.add(authUserId);
  }

  async hasOrdered(authUserId: string): Promise<boolean> {
    return this.ordered.has(authUserId);
  }
}
