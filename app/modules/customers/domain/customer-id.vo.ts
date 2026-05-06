import { randomUUID } from 'node:crypto';
import { InvalidCustomerError } from './customer.errors';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Entity は常に同一性（ID）を持つべきという DDD 原則に従い、ID は domain で生成する。
// DB 側の DEFAULT gen_random_uuid() は安全網として残す（infrastructure 段階で設定）。
export class CustomerId {
  private constructor(public readonly value: string) {}

  static generate(): CustomerId {
    return new CustomerId(randomUUID());
  }

  static from(value: string): CustomerId {
    if (!UUID_V4_REGEX.test(value)) {
      throw new InvalidCustomerError('CustomerId は UUID v4 形式である必要があります');
    }
    return new CustomerId(value);
  }

  equals(other: CustomerId): boolean {
    return this.value === other.value;
  }
}
