import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CustomerAuthPort,
  CustomerSignUpInput,
  CustomerSignUpResult,
} from '@/modules/customers/domain/customer-auth.port';
import {
  EmailAlreadyTakenError,
  SignUpFailedError,
} from '@/modules/customers/domain/customer.errors';

// ---------------------------------------------------------------------------
// Supabase Auth 経由のサインアップ Adapter（domain port の具象実装）。
//
// 役割:
//   - sb.auth.signUp() を呼び、auth.users 行を作る
//   - raw_user_meta_data に name を載せて handle_new_user トリガに渡す
//   - 既知のエラー（email 重複・パスワード不正）を domain 例外に翻訳する
//
// 使う Supabase クライアント:
//   サインアップは「未ログイン状態」の操作なので anon キーのクライアントで OK。
//   composition-root が per-request に組み立てた anon クライアントを注入する想定。
// ---------------------------------------------------------------------------

// Supabase Auth のエラーは status / message ベースで届く。
// 重複系は message が "User already registered" / "user already exists" 等。
// SDK 内部の型は隠れているので message を保守的に部分一致で見る。
const EMAIL_DUPLICATE_HINTS = ['already registered', 'user already exists'];
const PASSWORD_TOO_SHORT_HINTS = ['password', 'short'];

const includesAny = (message: string, hints: string[]): boolean => {
  const lowered = message.toLowerCase();
  return hints.some((hint) => lowered.includes(hint));
};

const isEmailAlreadyRegistered = (message: string): boolean =>
  includesAny(message, EMAIL_DUPLICATE_HINTS);

// "Password should be at least 6 characters" のような文言を雑に拾う。
// 完全一致しなくても SignUpFailedError に振り分けられればよい（細粒度は不要）。
const isPasswordTooShort = (message: string): boolean => {
  const lowered = message.toLowerCase();
  return PASSWORD_TOO_SHORT_HINTS.every((hint) => lowered.includes(hint));
};

export class SupabaseCustomerAuthAdapter implements CustomerAuthPort {
  constructor(private readonly sb: SupabaseClient) {}

  async signUp(input: CustomerSignUpInput): Promise<CustomerSignUpResult> {
    const { data, error } = await this.sb.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        // handle_new_user トリガが raw_user_meta_data->>'name' を読む。
        data: { name: input.name },
      },
    });

    if (error) {
      const message = error.message ?? 'サインアップに失敗しました';
      if (isEmailAlreadyRegistered(message)) {
        throw new EmailAlreadyTakenError(input.email);
      }
      if (isPasswordTooShort(message)) {
        throw new SignUpFailedError(message);
      }
      throw new SignUpFailedError(`サインアップに失敗しました: ${message}`);
    }

    const userId = data.user?.id;
    if (!userId) {
      // email confirm 必須設定の環境では user.id が来ても session が無いケースがあるが、
      // user.id 自体は signUp 直後に発行される。null になるのは想定外。
      throw new SignUpFailedError('サインアップ応答に user.id が含まれていません');
    }

    return { authUserId: userId };
  }
}
