import { InvalidEmailError } from './customer.errors';

const MAX_EMAIL_LENGTH = 254; // RFC 5321 の上限
// 簡易的な RFC 5322 互換チェック。完璧な検証は不可能なため、
// 明らかな不正のみを弾く方針。深い検証は外部送信時に委ねる。
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// メールアドレスは VO として正規化（小文字化）+ 検証する。
// 正規化を VO に閉じ込めることで、DB の UNIQUE 制約と
// アプリ側の比較ロジックがズレない。
export class Email {
  private constructor(public readonly value: string) {}

  static of(raw: string): Email {
    if (typeof raw !== 'string') {
      throw new InvalidEmailError('メールアドレスは文字列である必要があります');
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) {
      throw new InvalidEmailError('メールアドレスは必須です');
    }
    if (trimmed.length > MAX_EMAIL_LENGTH) {
      throw new InvalidEmailError(
        `メールアドレスは ${String(MAX_EMAIL_LENGTH)} 文字以内である必要があります`,
      );
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      throw new InvalidEmailError('メールアドレスの形式が不正です');
    }
    return new Email(trimmed);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}
