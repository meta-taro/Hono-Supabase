import { CustomerId } from './customer-id.vo';
import { Email } from './email.vo';
import { InvalidCustomerError } from './customer.errors';

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;

// auth.users.id を入れる文字列。Supabase Auth が UUID v4 を発行するため、
// ここでも同じ正規表現で受け入れる。
// CustomerId とは別概念（auth は外部 SoT、customers.id は業務 SoT）なので
// 同名にはせず、Customer 内部のフィールド型として string を素朴に保持する。
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertAuthUserId = (value: string): void => {
  if (!UUID_V4_REGEX.test(value)) {
    throw new InvalidCustomerError(`auth_user_id は UUID v4 である必要があります: ${value}`);
  }
};

// Customer = 顧客（集約根）。
// 不変条件は create() / reconstruct() の 2 経路でしか守れないように
// constructor を private にして外部からの new を禁ずる。
//
// Phase 6 で auth_user_id を追加。CustomerId（業務 ID、自動採番を維持）と
// authUserId（auth.users.id、Supabase Auth が発行）を併存させる B-2 案。
export class Customer {
  private constructor(
    public readonly id: CustomerId,
    public readonly authUserId: string,
    public readonly name: string,
    public readonly email: Email,
  ) {}

  // 新規作成: 業務ルールをすべて適用する。
  // authUserId は呼び出し側（UseCase）が auth.signUp の戻り値から渡す前提。
  static create(input: { authUserId: string; name: string; email: string }): Customer {
    assertAuthUserId(input.authUserId);
    const trimmed = input.name.trim();
    if (trimmed.length < NAME_MIN_LENGTH) {
      throw new InvalidCustomerError('顧客名は必須です');
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      throw new InvalidCustomerError(`顧客名は ${NAME_MAX_LENGTH} 文字以内です`);
    }
    return new Customer(
      CustomerId.generate(),
      input.authUserId,
      trimmed,
      Email.of(input.email),
    );
  }

  // 永続化層からの復元: DB の値を信頼するが、VO 経由は必ず通すため
  // 壊れた id / email はここで弾かれる（Fail-Fast）。
  static reconstruct(props: {
    id: string;
    authUserId: string;
    name: string;
    email: string;
  }): Customer {
    assertAuthUserId(props.authUserId);
    return new Customer(
      CustomerId.from(props.id),
      props.authUserId,
      props.name,
      Email.of(props.email),
    );
  }
}
