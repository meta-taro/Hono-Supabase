import { InvalidPriceError } from './cake.errors';

const MIN_PRICE = 1;
const MAX_PRICE = 1_000_000;

// JPY を円単位の整数として表現する。多通貨化や Decimal が必要になったら見直す。
export class Price {
  private constructor(public readonly value: number) {}

  static of(value: number): Price {
    if (!Number.isInteger(value)) {
      throw new InvalidPriceError('価格は整数である必要があります');
    }
    if (value < MIN_PRICE) {
      throw new InvalidPriceError(`価格は ${String(MIN_PRICE)} 以上である必要があります`);
    }
    if (value > MAX_PRICE) {
      throw new InvalidPriceError(`価格は ${MAX_PRICE.toLocaleString()} 以下である必要があります`);
    }
    return new Price(value);
  }

  equals(other: Price): boolean {
    return this.value === other.value;
  }
}
