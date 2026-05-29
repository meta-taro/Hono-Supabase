import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { OrderHistoryChecker } from '@/modules/reviews/domain/order-history.checker';

// Supabase 経由の OrderHistoryChecker 実装。
//   has_ordered(p_auth_user_id) RPC を呼ぶだけ。
//   RPC は security invoker で動くため、呼び出しユーザーの RLS（自分の orders のみ可視）
//   に従う = 他人の利用実績を漏洩しない。
//
// orders コンテキストを直接 import せず、SQL 関数を間に挟むことで
// 「コンテキスト間の直接参照禁止」（CLAUDE.md）を維持する。
export class SupabaseOrderHistoryChecker implements OrderHistoryChecker {
  constructor(private readonly sb: SupabaseClient) {}

  async hasOrdered(authUserId: string): Promise<boolean> {
    const { data, error } = (await this.sb.rpc('has_ordered', {
      p_auth_user_id: authUserId,
    })) as { data: boolean | null; error: PostgrestError | null };

    if (error) {
      throw new Error(`利用実績の判定に失敗しました: ${error.message}`);
    }
    // RPC が boolean を返す前提だが、null は安全側に倒して未利用扱いにする
    // （= 「利用客バッジを付けない」誤判定で、機微情報の漏洩にはならない）。
    return data === true;
  }
}
