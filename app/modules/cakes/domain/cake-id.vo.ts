import { InvalidCakeError } from './cake.errors';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Entity は常に同一性（ID）を持つべきという DDD 原則に従い、ID は domain で生成する。
// DB 側の DEFAULT gen_random_uuid() は安全網として残す（infrastructure 段階で設定）。
//
// crypto.randomUUID は Web Crypto API。Node 19+ / Cloudflare Workers / ブラウザ
// すべてでグローバルに利用可能。node:crypto を import すると Workers 互換性を壊すので避ける。
export class CakeId {
  private constructor(public readonly value: string) {}

  static generate(): CakeId {
    return new CakeId(crypto.randomUUID());
  }

  static from(value: string): CakeId {
    if (!UUID_V4_REGEX.test(value)) {
      throw new InvalidCakeError('CakeId は UUID v4 形式である必要があります');
    }
    return new CakeId(value);
  }

  equals(other: CakeId): boolean {
    return this.value === other.value;
  }
}
