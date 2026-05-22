import { CakeId } from './cake-id.vo';
import { Price } from './price.vo';
import { InvalidCakeError } from './cake.errors';

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;

// 新規作成時の version。DB 側 cakes.version の default 1 と一致させる
// （楽観ロック: 更新のたびに DB トリガが +1 する。Phase 10 Step 4）。
const INITIAL_VERSION = 1;

// 在庫数の不変条件（create / changeStock で共通に使う）。
const assertValidStock = (stock: number): void => {
  if (!Number.isInteger(stock) || stock < 0) {
    throw new InvalidCakeError('在庫数は 0 以上の整数です');
  }
};

// Cake = ケーキそのもの（集約根）。
// 不変条件は create() / reconstruct() の 2 経路でしか守れないように
// constructor を private にして外部からの new を禁ずる。
export class Cake {
  private constructor(
    public readonly id: CakeId,
    public readonly name: string,
    public readonly price: Price,
    public readonly stock: number,
    // 楽観ロック用のバージョン。「この Cake が DB 上で何世代目か」を表す。
    // 採番（+1）は永続化層（DB トリガ）の責務で、domain は読み取って運ぶだけ。
    public readonly version: number,
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
    assertValidStock(input.stock);
    return new Cake(
      CakeId.generate(),
      trimmed,
      Price.of(input.price),
      input.stock,
      INITIAL_VERSION,
    );
  }

  // 永続化層からの復元: DB の値を信頼するが、VO 経由は必ず通すため
  // 壊れた id / price はここで弾かれる（Fail-Fast）。
  static reconstruct(props: {
    id: string;
    name: string;
    price: number;
    stock: number;
    version: number;
  }): Cake {
    return new Cake(
      CakeId.from(props.id),
      props.name,
      Price.of(props.price),
      props.stock,
      props.version,
    );
  }

  // 在庫数を変更した「新しい」Cake を返す（イミュータブル更新）。
  // version は据え置く: 新世代の採番は repository（DB トリガ）が担い、
  // 楽観ロックの照合は「呼び出し元が持っている version」で行うため。
  changeStock(newStock: number): Cake {
    assertValidStock(newStock);
    return new Cake(this.id, this.name, this.price, newStock, this.version);
  }
}
