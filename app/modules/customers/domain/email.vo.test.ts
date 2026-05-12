import { describe, it, expect } from 'vitest';
import { Email } from './email.vo';
import { InvalidEmailError } from './customer.errors';

describe('Email.of', () => {
  it('正しい形式のメールアドレスを受け入れる', () => {
    expect(Email.of('user@example.com').value).toBe('user@example.com');
    expect(Email.of('a.b+tag@example.co.jp').value).toBe('a.b+tag@example.co.jp');
  });

  it('大文字を小文字に正規化する', () => {
    expect(Email.of('User@Example.COM').value).toBe('user@example.com');
  });

  it('前後の空白をトリムする', () => {
    expect(Email.of('  user@example.com  ').value).toBe('user@example.com');
  });

  it('空文字を拒否する', () => {
    expect(() => Email.of('')).toThrow(InvalidEmailError);
  });

  it('空白のみを拒否する', () => {
    expect(() => Email.of('   ')).toThrow(InvalidEmailError);
  });

  it('@ を含まない文字列を拒否する', () => {
    expect(() => Email.of('not-email')).toThrow(InvalidEmailError);
  });

  it('ドメイン部にドットがない場合を拒否する', () => {
    expect(() => Email.of('user@example')).toThrow(InvalidEmailError);
  });

  it('スペースを含むものを拒否する', () => {
    expect(() => Email.of('user @example.com')).toThrow(InvalidEmailError);
  });

  it('254 文字超を拒否する', () => {
    const local = 'a'.repeat(250);
    const tooLong = `${local}@e.co`; // 長さは 250 + 5 = 255
    expect(() => Email.of(tooLong)).toThrow(InvalidEmailError);
  });
});

describe('Email.equals', () => {
  it('同じ value なら true', () => {
    expect(Email.of('user@example.com').equals(Email.of('user@example.com'))).toBe(true);
  });

  it('大文字小文字違いでも正規化されて true', () => {
    expect(Email.of('User@Example.com').equals(Email.of('user@example.com'))).toBe(true);
  });

  it('違うアドレスなら false', () => {
    expect(Email.of('a@example.com').equals(Email.of('b@example.com'))).toBe(false);
  });
});
