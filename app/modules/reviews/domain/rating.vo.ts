import { InvalidRatingError } from './review.errors';

const MIN_RATING = 1;
const MAX_RATING = 5;

// 星評価。1〜5 の整数のみ受け付ける（0.5 刻みは Phase 11 では非対応 = ecake.jp も整数評価）。
// 集計は infrastructure 側で SQL AVG / COUNT を取るため、ここでは個別の値だけ管理する。
export class Rating {
  private constructor(public readonly value: number) {}

  static of(value: number): Rating {
    if (!Number.isInteger(value)) {
      throw new InvalidRatingError('星評価は整数である必要があります');
    }
    if (value < MIN_RATING || value > MAX_RATING) {
      throw new InvalidRatingError(
        `星評価は ${String(MIN_RATING)} 以上 ${String(MAX_RATING)} 以下である必要があります`,
      );
    }
    return new Rating(value);
  }

  equals(other: Rating): boolean {
    return this.value === other.value;
  }
}
