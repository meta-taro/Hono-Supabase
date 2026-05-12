import { CakeId } from './cake-id.vo';
import { Price } from './price.vo';
import { InvalidCakeError } from './cake.errors';

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;

// Cake = ケーキそのもの（集約根）。
// 不変条件は create() / reconstruct() の 2 経路でしか守れないように
// constructor を private にして外部からの new を禁ずる。
export class Cake {
  private constructor(
    public readonly id: CakeId,
    public readonly name: string,
    public readonly price: Price,
    public readonly stock: number,
  ) {}

  // 新規作成: 業務ルールをすべて適用する。
  static create(input: { name: string; price: number; stock: number }): Cake {
    const trimmed = input.name.trim();
    if (trimmed.length < NAME_MIN_LENGTH) {
      throw new InvalidCakeError('ケーキ名は必須です');
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      throw new InvalidCakeError(`ケーキ名は ${String(NAME_MAX_LENGTH)} 文字以内です`);
    }
    if (!Number.isInteger(input.stock) || input.stock < 0) {
      throw new InvalidCakeError('在庫数は 0 以上の整数です');
    }
    return new Cake(CakeId.generate(), trimmed, Price.of(input.price), input.stock);
  }

  // 永続化層からの復元: DB の値を信頼するが、VO 経由は必ず通すため
  // 壊れた id / price はここで弾かれる（Fail-Fast）。
  static reconstruct(props: { id: string; name: string; price: number; stock: number }): Cake {
    return new Cake(CakeId.from(props.id), props.name, Price.of(props.price), props.stock);
  }
}
