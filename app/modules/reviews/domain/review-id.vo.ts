import { InvalidReviewError } from './review.errors';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Entity は同一性（ID）を持つ。生成は domain で行い、DB 側 DEFAULT gen_random_uuid() は安全網。
// crypto.randomUUID は Node 19+ / Workers / ブラウザのいずれでもグローバル提供されているので
// node:crypto を import せずに済む（Workers 互換を保つ）。
export class ReviewId {
  private constructor(public readonly value: string) {}

  static generate(): ReviewId {
    return new ReviewId(crypto.randomUUID());
  }

  static from(value: string): ReviewId {
    if (!UUID_V4_REGEX.test(value)) {
      throw new InvalidReviewError('ReviewId は UUID v4 形式である必要があります');
    }
    return new ReviewId(value);
  }

  equals(other: ReviewId): boolean {
    return this.value === other.value;
  }
}
