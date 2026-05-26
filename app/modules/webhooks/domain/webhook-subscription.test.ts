import { describe, it, expect } from 'vitest';
import { WebhookSubscription, WebhookSubscriptionInvalidError } from './webhook-subscription';

// ---------------------------------------------------------------------------
// WebhookSubscription の不変条件
//   URL は http/https のみ、secret は 32〜256 文字。
//   create と reconstruct の双方で Fail-Fast を担保する。
// ---------------------------------------------------------------------------

const VALID_SECRET = 'a'.repeat(64);

describe('WebhookSubscription.create', () => {
  it('正しい URL + secret + description で作成できる', () => {
    const s = WebhookSubscription.create({
      id: 'sub-1',
      url: 'https://example.com/hook',
      secret: VALID_SECRET,
      description: 'test',
    });
    expect(s.id).toBe('sub-1');
    expect(s.url).toBe('https://example.com/hook');
    expect(s.secret).toBe(VALID_SECRET);
    expect(s.description).toBe('test');
    expect(s.active).toBe(true);
  });

  it('description 省略時は null になる', () => {
    const s = WebhookSubscription.create({
      id: 'sub-2',
      url: 'https://example.com',
      secret: VALID_SECRET,
    });
    expect(s.description).toBeNull();
  });

  it('http スキームも許可する（ローカル開発のため）', () => {
    const s = WebhookSubscription.create({
      id: 'sub-3',
      url: 'http://localhost:3000/hook',
      secret: VALID_SECRET,
    });
    expect(s.url).toBe('http://localhost:3000/hook');
  });

  it.each([
    ['空文字', ''],
    ['ftp スキーム', 'ftp://example.com'],
    ['file スキーム', 'file:///etc/passwd'],
    ['壊れた URL', 'not-a-url'],
  ])('URL が不正なら %s で WebhookSubscriptionInvalidError', (_label, badUrl) => {
    expect(() =>
      WebhookSubscription.create({ id: 'x', url: badUrl, secret: VALID_SECRET }),
    ).toThrow(WebhookSubscriptionInvalidError);
  });

  it('URL が 2048 文字超なら不正', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2050);
    expect(() =>
      WebhookSubscription.create({ id: 'x', url: longUrl, secret: VALID_SECRET }),
    ).toThrow(WebhookSubscriptionInvalidError);
  });

  it('secret が 32 文字未満なら不正', () => {
    expect(() =>
      WebhookSubscription.create({
        id: 'x',
        url: 'https://example.com',
        secret: 'a'.repeat(31),
      }),
    ).toThrow(WebhookSubscriptionInvalidError);
  });

  it('secret が 256 文字超なら不正', () => {
    expect(() =>
      WebhookSubscription.create({
        id: 'x',
        url: 'https://example.com',
        secret: 'a'.repeat(257),
      }),
    ).toThrow(WebhookSubscriptionInvalidError);
  });
});

describe('WebhookSubscription.reconstruct', () => {
  it('永続化からの復元時も URL / secret を再検証する（Fail-Fast）', () => {
    expect(() =>
      WebhookSubscription.reconstruct({
        id: 'x',
        url: 'ftp://bad',
        secret: VALID_SECRET,
        description: null,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow(WebhookSubscriptionInvalidError);
  });
});
