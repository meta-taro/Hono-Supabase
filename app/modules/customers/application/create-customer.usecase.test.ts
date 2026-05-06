import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createCreateCustomerUseCase } from './create-customer.usecase';
import { InMemoryCustomerRepository } from './__test-helpers__/in-memory-customer.repository';
import { Customer } from '../domain/customer';
import {
  InvalidCustomerError,
  InvalidEmailError,
  EmailAlreadyTakenError,
} from '../domain/customer.errors';

// テスト用に出力を捨てる silent ロガー（pino の標準オプション）
const silentLogger = pino({ level: 'silent' });

describe('createCustomerUseCase', () => {
  it('正しい入力で Customer を生成し、リポジトリに保存される', async () => {
    const repo = new InMemoryCustomerRepository();
    const createCustomer = createCreateCustomerUseCase(repo, silentLogger);

    const customer = await createCustomer({
      name: '田中太郎',
      email: 'tanaka@example.com',
    });

    expect(customer.name).toBe('田中太郎');
    expect(customer.email.value).toBe('tanaka@example.com');
    expect(repo.size()).toBe(1);
  });

  it('生成された Customer は list() で取得できる', async () => {
    const repo = new InMemoryCustomerRepository();
    const createCustomer = createCreateCustomerUseCase(repo, silentLogger);

    await createCustomer({ name: '山田花子', email: 'yamada@example.com' });
    const stored = await repo.list();

    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('山田花子');
  });

  it('成功時に info ログを出力する', async () => {
    const repo = new InMemoryCustomerRepository();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createCreateCustomerUseCase
    >[1];
    const createCustomer = createCreateCustomerUseCase(repo, fakeLogger);

    const customer = await createCustomer({
      name: '鈴木一郎',
      email: 'suzuki@example.com',
    });

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      { customerId: customer.id.value, email: 'suzuki@example.com' },
      'Customer created',
    );
  });

  it('既に登録済みのメールアドレスでは EmailAlreadyTakenError を投げ、保存されない', async () => {
    const repo = new InMemoryCustomerRepository();
    await repo.save(Customer.create({ name: '既存ユーザ', email: 'taken@example.com' }));
    const createCustomer = createCreateCustomerUseCase(repo, silentLogger);

    await expect(
      createCustomer({ name: '新規ユーザ', email: 'taken@example.com' }),
    ).rejects.toThrow(EmailAlreadyTakenError);
    expect(repo.size()).toBe(1);
  });

  it('メールアドレスの大文字小文字違いも重複として扱う（正規化）', async () => {
    const repo = new InMemoryCustomerRepository();
    await repo.save(Customer.create({ name: 'A', email: 'user@example.com' }));
    const createCustomer = createCreateCustomerUseCase(repo, silentLogger);

    await expect(
      createCustomer({ name: 'B', email: 'USER@EXAMPLE.COM' }),
    ).rejects.toThrow(EmailAlreadyTakenError);
    expect(repo.size()).toBe(1);
  });

  it('不正な name では Customer.create が例外を投げ、保存されない', async () => {
    const repo = new InMemoryCustomerRepository();
    const createCustomer = createCreateCustomerUseCase(repo, silentLogger);

    await expect(
      createCustomer({ name: '', email: 'a@b.co' }),
    ).rejects.toThrow(InvalidCustomerError);
    expect(repo.size()).toBe(0);
  });

  it('不正な email では Email.of が例外を投げ、保存されない', async () => {
    const repo = new InMemoryCustomerRepository();
    const createCustomer = createCreateCustomerUseCase(repo, silentLogger);

    await expect(
      createCustomer({ name: 'a', email: 'invalid' }),
    ).rejects.toThrow(InvalidEmailError);
    expect(repo.size()).toBe(0);
  });
});
