import { InvalidOrderError } from './order.errors';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// orders コンテキストにおける CustomerId VO。
// customers/domain/customer-id.vo.ts と内容は重複するが、
// 「コンテキスト間の直接参照禁止」（CLAUDE.md）のため自前で定義する。
//
// なぜ重複を許すのか:
//   - 各コンテキストは「他コンテキストの ID をどう扱うか」を独立に決める権利を持つ
//   - もし customers 側が CustomerId の体系を変えても、orders は影響を受けない
//   - 重複コストは小さい（25 行の VO）／結合コストは大きい（解放できないクラスの結合）
export class CustomerId {
  private constructor(public readonly value: string) {}

  static from(value: string): CustomerId {
    if (!UUID_V4_REGEX.test(value)) {
      throw new InvalidOrderError('CustomerId は UUID v4 形式である必要があります');
    }
    return new CustomerId(value);
  }

  equals(other: CustomerId): boolean {
    return this.value === other.value;
  }
}
