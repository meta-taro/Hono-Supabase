import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { CakeId } from '@/modules/reviews/domain/cake-id.vo';
import type { VerifiedPurchaserChecker } from '@/modules/reviews/domain/verified-purchaser.checker';

// Supabase 経由の VerifiedPurchaserChecker 実装。
//   has_purchased(p_auth_user_id, p_cake_id) RPC を呼ぶだけ。
//   RPC は security invoker で動くため、呼び出しユーザーの RLS（自分の orders のみ可視）
//   に従う = 他人の購入実績を漏洩しない。
//
// orders コンテキストを直接 import せず、SQL 関数を間に挟むことで
// 「コンテキスト間の直接参照禁止」（CLAUDE.md）を維持する。
export class SupabaseVerifiedPurchaserChecker implements VerifiedPurchaserChecker {
  constructor(private readonly sb: SupabaseClient) {}

  async hasPurchased(authUserId: string, cakeId: CakeId): Promise<boolean> {
    const { data, error } = (await this.sb.rpc('has_purchased', {
      p_auth_user_id: authUserId,
      p_cake_id: cakeId.value,
    })) as { data: boolean | null; error: PostgrestError | null };

    if (error) {
      throw new Error(`購入実績の判定に失敗しました: ${error.message}`);
    }
    // RPC が boolean を返す前提だが、null は安全側に倒して未購入扱いにする
    // （= 「購入済みバッジを付けない」誤判定で、機微情報の漏洩にはならない）。
    return data === true;
  }
}
