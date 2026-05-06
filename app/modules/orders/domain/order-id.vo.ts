import { randomUUID } from 'node:crypto';
import { InvalidOrderError } from './order.errors';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// OrderId は orders Bounded Context が所有する識別子。
// cakes / customers のそれと実装が酷似するが、CLAUDE.md の依存ルールに従い
// 「コンテキストごとに自前で持つ」を貫くために再定義している（共有しない）。
export class OrderId {
  private constructor(public readonly value: string) {}

  static generate(): OrderId {
    return new OrderId(randomUUID());
  }

  static from(value: string): OrderId {
    if (!UUID_V4_REGEX.test(value)) {
      throw new InvalidOrderError('OrderId は UUID v4 形式である必要があります');
    }
    return new OrderId(value);
  }

  equals(other: OrderId): boolean {
    return this.value === other.value;
  }
}
