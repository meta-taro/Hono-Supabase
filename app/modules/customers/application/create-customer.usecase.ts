import type { Logger } from 'pino';
import { Customer } from '../domain/customer';
import { Email } from '../domain/email.vo';
import { EmailAlreadyTakenError } from '../domain/customer.errors';
import type { CustomerRepository } from '../domain/customer.repository';

// UseCase の入力 DTO。プリミティブ型のみ（domain VO は外部から見せない）。
export interface CreateCustomerInput {
  name: string;
  email: string;
}

// 業務手順:
//   1. Email VO を作って形式検証 + 正規化（重複チェックを正規化済み値で行うため）
//   2. findByEmail で重複チェック → 既存なら EmailAlreadyTakenError
//   3. Customer.create() で Entity を生成（壊れた入力はここで弾かれる）
//   4. Repository に永続化
//   5. ビジネスイベントとして info ログ
//
// 注意: 重複チェック → 保存の間にレースコンディションがあり得る。
// 最終的な一意性は DB の UNIQUE 制約で担保する（infrastructure 層で 23505 を CONFLICT に変換）。
// ここのチェックは早期リターンによる UX 改善目的。
export const createCreateCustomerUseCase = (
  repo: CustomerRepository,
  logger: Logger,
) => {
  return async (input: CreateCustomerInput): Promise<Customer> => {
    const email = Email.of(input.email);
    const existing = await repo.findByEmail(email);
    if (existing !== null) {
      throw new EmailAlreadyTakenError(email.value);
    }
    const customer = Customer.create(input);
    await repo.save(customer);
    logger.info(
      { customerId: customer.id.value, email: customer.email.value },
      'Customer created',
    );
    return customer;
  };
};

export type CreateCustomerUseCase = ReturnType<typeof createCreateCustomerUseCase>;
