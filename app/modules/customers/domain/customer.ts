import { CustomerId } from './customer-id.vo';
import { Email } from './email.vo';
import { InvalidCustomerError } from './customer.errors';

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;

// Customer = 顧客（集約根）。
// 不変条件は create() / reconstruct() の 2 経路でしか守れないように
// constructor を private にして外部からの new を禁ずる。
export class Customer {
  private constructor(
    public readonly id: CustomerId,
    public readonly name: string,
    public readonly email: Email,
  ) {}

  // 新規作成: 業務ルールをすべて適用する。
  static create(input: { name: string; email: string }): Customer {
    const trimmed = input.name.trim();
    if (trimmed.length < NAME_MIN_LENGTH) {
      throw new InvalidCustomerError('顧客名は必須です');
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      throw new InvalidCustomerError(`顧客名は ${NAME_MAX_LENGTH} 文字以内です`);
    }
    return new Customer(CustomerId.generate(), trimmed, Email.of(input.email));
  }

  // 永続化層からの復元: DB の値を信頼するが、VO 経由は必ず通すため
  // 壊れた id / email はここで弾かれる（Fail-Fast）。
  static reconstruct(props: { id: string; name: string; email: string }): Customer {
    return new Customer(
      CustomerId.from(props.id),
      props.name,
      Email.of(props.email),
    );
  }
}
