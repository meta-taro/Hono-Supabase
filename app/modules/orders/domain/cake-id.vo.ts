import { InvalidOrderError } from './order.errors';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// orders コンテキストにおける CakeId VO。
// cakes/domain/cake-id.vo.ts と内容は重複するが、
// 「コンテキスト間の直接参照禁止」（CLAUDE.md）のため自前で定義する。
// orders 側は cakes の Cake Entity 全体を必要としない。「商品を識別する UUID」だけ必要。
export class CakeId {
  private constructor(public readonly value: string) {}

  static from(value: string): CakeId {
    if (!UUID_V4_REGEX.test(value)) {
      throw new InvalidOrderError('CakeId は UUID v4 形式である必要があります');
    }
    return new CakeId(value);
  }

  equals(other: CakeId): boolean {
    return this.value === other.value;
  }
}
