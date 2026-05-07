import type { Logger } from 'pino';
import type { Customer } from '../domain/customer';
import { Email } from '../domain/email.vo';
import {
  CustomerNotFoundError,
  EmailAlreadyTakenError,
} from '../domain/customer.errors';
import type { CustomerRepository } from '../domain/customer.repository';
import type { CustomerAuthPort } from '../domain/customer-auth.port';

// UseCase の入力 DTO。プリミティブ型のみ（domain VO は外部から見せない）。
// Phase 6 で password が必須になり、サインアップ相当の業務手順に置き換わる。
export interface SignUpCustomerInput {
  name: string;
  email: string;
  password: string;
}

// 業務手順（Phase 6 改定版）:
//   1. Email VO を作って形式検証 + 正規化（重複チェックを正規化済み値で行うため）
//   2. findByEmail で重複チェック → 既存なら EmailAlreadyTakenError（早期リターン）
//   3. CustomerAuthPort.signUp() で auth.users を作成
//      → DB トリガ handle_new_user が customers 行を 1 トランザクションで挿入
//   4. authUserId 経由で customers 行を読み戻し（Entity 化）
//   5. ビジネスイベントとして info ログ
//
// なぜ「2 で重複チェックしてから 3 で signUp」なのか:
//   Supabase Auth 自体も email の一意性を担保するが、エラー文言が
//   実装依存（"User already registered" 等）になりがち。
//   先にアプリ側でチェックして専用例外を投げることで、
//   API のエラーメッセージが業務観点で安定する（UX 改善）。
//   なお最終的な一意性は DB の UNIQUE 制約と Supabase Auth が二重で担保する。
export const createSignUpCustomerUseCase = (
  auth: CustomerAuthPort,
  repo: CustomerRepository,
  logger: Logger,
) => {
  return async (input: SignUpCustomerInput): Promise<Customer> => {
    const email = Email.of(input.email);

    const existing = await repo.findByEmail(email);
    if (existing !== null) {
      throw new EmailAlreadyTakenError(email.value);
    }

    const { authUserId } = await auth.signUp({
      email: email.value,
      password: input.password,
      name: input.name,
    });

    // handle_new_user トリガが同一トランザクション内で customers 行を作っているはずなので、
    // ここで null になるのは実質的に内部矛盾。明示的な例外として扱う。
    const customer = await repo.findByAuthUserId(authUserId);
    if (customer === null) {
      throw new CustomerNotFoundError(
        `signUp 後の customers 行が見つかりません (authUserId=${authUserId})`,
      );
    }

    logger.info(
      { customerId: customer.id.value, email: customer.email.value },
      'Customer signed up',
    );
    return customer;
  };
};

export type SignUpCustomerUseCase = ReturnType<typeof createSignUpCustomerUseCase>;
