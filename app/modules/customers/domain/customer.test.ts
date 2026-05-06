import { describe, it, expect } from 'vitest';
import { Customer } from './customer';
import { CustomerId } from './customer-id.vo';
import { Email } from './email.vo';
import { InvalidCustomerError, InvalidEmailError } from './customer.errors';

describe('Customer.create', () => {
  it('正しい入力で Customer を生成し、ID は自動採番される', () => {
    const customer = Customer.create({ name: '田中太郎', email: 'tanaka@example.com' });
    expect(customer.id).toBeInstanceOf(CustomerId);
    expect(customer.name).toBe('田中太郎');
    expect(customer.email).toBeInstanceOf(Email);
    expect(customer.email.value).toBe('tanaka@example.com');
  });

  it('name は前後の空白がトリムされる', () => {
    const customer = Customer.create({ name: '  山田花子  ', email: 'yamada@example.com' });
    expect(customer.name).toBe('山田花子');
  });

  it('email は小文字に正規化される', () => {
    const customer = Customer.create({ name: 'a', email: 'User@Example.COM' });
    expect(customer.email.value).toBe('user@example.com');
  });

  it('name 空文字を拒否する', () => {
    expect(() => Customer.create({ name: '', email: 'a@b.co' })).toThrow(
      InvalidCustomerError,
    );
  });

  it('name 空白のみを拒否する', () => {
    expect(() => Customer.create({ name: '   ', email: 'a@b.co' })).toThrow(
      InvalidCustomerError,
    );
  });

  it('name 100 文字超を拒否する', () => {
    const longName = 'あ'.repeat(101);
    expect(() => Customer.create({ name: longName, email: 'a@b.co' })).toThrow(
      InvalidCustomerError,
    );
  });

  it('email が不正なら Email の例外が伝播する', () => {
    expect(() => Customer.create({ name: 'a', email: 'invalid' })).toThrow(
      InvalidEmailError,
    );
  });

  it('生成された ID はそれぞれユニーク', () => {
    const a = Customer.create({ name: 'a', email: 'a@example.com' });
    const b = Customer.create({ name: 'b', email: 'b@example.com' });
    expect(a.id.value).not.toBe(b.id.value);
  });
});

describe('Customer.reconstruct', () => {
  it('永続化層からの値で Customer を復元する', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const customer = Customer.reconstruct({
      id,
      name: '田中太郎',
      email: 'tanaka@example.com',
    });
    expect(customer.id.value).toBe(id);
    expect(customer.name).toBe('田中太郎');
    expect(customer.email.value).toBe('tanaka@example.com');
  });

  it('壊れた id では復元できない', () => {
    expect(() =>
      Customer.reconstruct({ id: 'not-uuid', name: 'a', email: 'a@b.co' }),
    ).toThrow(InvalidCustomerError);
  });

  it('壊れた email では復元できない（Fail-Fast）', () => {
    expect(() =>
      Customer.reconstruct({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'a',
        email: 'invalid',
      }),
    ).toThrow(InvalidEmailError);
  });
});
