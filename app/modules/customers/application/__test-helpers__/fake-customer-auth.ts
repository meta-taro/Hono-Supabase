import { randomUUID } from 'node:crypto';
import { Customer } from '../../domain/customer';
import {
  EmailAlreadyTakenError,
  SignUpFailedError,
} from '../../domain/customer.errors';
import type {
  CustomerAuthPort,
  CustomerSignUpInput,
  CustomerSignUpResult,
} from '../../domain/customer-auth.port';
import type { InMemoryCustomerRepository } from './in-memory-customer.repository';

// ---------------------------------------------------------------------------
// 本番では Supabase Auth が auth.users を作り、handle_new_user トリガが
// customers 行を作る。テストではその「2 段の挙動」をこのフェイクが模擬する:
//   1. 新しい auth_user_id を発行（randomUUID）
//   2. InMemoryCustomerRepository.seed() で customers 行を作る
//
// Email 重複は Supabase Auth が UserAlreadyRegistered で拒否するので、
// このフェイクも事前に findByEmail を引いて EmailAlreadyTakenError を投げる。
// ---------------------------------------------------------------------------
export class FakeCustomerAuth implements CustomerAuthPort {
  constructor(private readonly repo: InMemoryCustomerRepository) {}

  async signUp(input: CustomerSignUpInput): Promise<CustomerSignUpResult> {
    if (input.password.length < 6) {
      // Supabase Auth のデフォルト挙動（最小 6 文字）に合わせる
      throw new SignUpFailedError('パスワードは 6 文字以上である必要があります');
    }

    const tentativeEmail = input.email.trim().toLowerCase();
    const existing = await this.repo.findByEmail(
      // findByEmail は Email VO を要求するので、Customer.create 経由で
      // 正規化済みのインスタンスを使う方がシンプルだが、ここはテスト用なので
      // 簡易に email 値で当たりだけ取る。
      { value: tentativeEmail, equals: (o) => o.value === tentativeEmail },
    );
    if (existing !== null) {
      throw new EmailAlreadyTakenError(tentativeEmail);
    }

    const authUserId = randomUUID();
    // 本番のトリガ処理を JS 側で再現する。
    const customer = Customer.create({
      authUserId,
      name: input.name,
      email: input.email,
    });
    this.repo.seed(customer);
    return { authUserId };
  }
}
