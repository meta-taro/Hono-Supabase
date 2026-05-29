import type { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import type { VerifiedPurchaserChecker } from '@/modules/reviews/domain/verified-purchaser.checker';

// テスト用の in-memory 実装。
//   - コンストラクタで「購入済み」と判定する (authUserId, cakeId) のペアを受け取る。
//   - 既定では全件 false（=未購入）。
// 本番経路は infrastructure 層で orders テーブルを参照する別実装を用意する。
export class InMemoryVerifiedPurchaserChecker implements VerifiedPurchaserChecker {
  private readonly purchases: Set<string>;

  constructor(pairs: Array<{ authUserId: string; cakeId: string }> = []) {
    this.purchases = new Set(pairs.map((p) => key(p.authUserId, p.cakeId)));
  }

  // 動的に購入実績を足す（テスト中に状態を変えたいケース用）。
  markPurchased(authUserId: string, cakeId: string): void {
    this.purchases.add(key(authUserId, cakeId));
  }

  async hasPurchased(authUserId: string, cakeId: CakeId): Promise<boolean> {
    return this.purchases.has(key(authUserId, cakeId.value));
  }
}

const key = (authUserId: string, cakeId: string): string => `${authUserId}::${cakeId}`;
