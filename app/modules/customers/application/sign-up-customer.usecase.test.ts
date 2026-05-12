import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { createSignUpCustomerUseCase } from './sign-up-customer.usecase';
import { InMemoryCustomerRepository } from './__test-helpers__/in-memory-customer.repository';
import { FakeCustomerAuth } from './__test-helpers__/fake-customer-auth';
import { Customer } from '../domain/customer';
import {
  InvalidCustomerError,
  InvalidEmailError,
  EmailAlreadyTakenError,
  SignUpFailedError,
} from '../domain/customer.errors';

// テスト用に出力を捨てる silent ロガー（AppLogger no-op 実装）
const silentLogger = createSilentLogger();

const SAMPLE_AUTH_USER_ID = '11111111-1111-4111-8111-111111111111';

const buildDeps = () => {
  const repo = new InMemoryCustomerRepository();
  const auth = new FakeCustomerAuth(repo);
  return { repo, auth };
};

describe('signUpCustomerUseCase', () => {
  it('正しい入力で Customer を生成し、リポジトリに保存される', async () => {
    const { repo, auth } = buildDeps();
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    const customer = await signUp({
      name: '田中太郎',
      email: 'tanaka@example.com',
      password: 'secret123',
    });

    expect(customer.name).toBe('田中太郎');
    expect(customer.email.value).toBe('tanaka@example.com');
    expect(customer.authUserId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(repo.size()).toBe(1);
  });

  it('生成された Customer は list() で取得できる', async () => {
    const { repo, auth } = buildDeps();
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    await signUp({
      name: '山田花子',
      email: 'yamada@example.com',
      password: 'secret123',
    });
    const stored = await repo.list();

    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('山田花子');
  });

  it('成功時に info ログを出力する', async () => {
    const { repo, auth } = buildDeps();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createSignUpCustomerUseCase
    >[2];
    const signUp = createSignUpCustomerUseCase(auth, repo, fakeLogger);

    const customer = await signUp({
      name: '鈴木一郎',
      email: 'suzuki@example.com',
      password: 'secret123',
    });

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      { customerId: customer.id.value, email: 'suzuki@example.com' },
      'Customer signed up',
    );
  });

  it('既に登録済みのメールアドレスでは EmailAlreadyTakenError を投げ、auth.signUp は呼ばれない', async () => {
    const { repo, auth } = buildDeps();
    const authSpy = vi.spyOn(auth, 'signUp');
    repo.seed(
      Customer.create({
        authUserId: SAMPLE_AUTH_USER_ID,
        name: '既存ユーザ',
        email: 'taken@example.com',
      }),
    );
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    await expect(
      signUp({
        name: '新規ユーザ',
        email: 'taken@example.com',
        password: 'secret123',
      }),
    ).rejects.toThrow(EmailAlreadyTakenError);
    expect(repo.size()).toBe(1);
    expect(authSpy).not.toHaveBeenCalled();
  });

  it('メールアドレスの大文字小文字違いも重複として扱う（正規化）', async () => {
    const { repo, auth } = buildDeps();
    repo.seed(
      Customer.create({
        authUserId: SAMPLE_AUTH_USER_ID,
        name: 'A',
        email: 'user@example.com',
      }),
    );
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    await expect(
      signUp({
        name: 'B',
        email: 'USER@EXAMPLE.COM',
        password: 'secret123',
      }),
    ).rejects.toThrow(EmailAlreadyTakenError);
    expect(repo.size()).toBe(1);
  });

  it('不正な name では Customer.create が例外を投げ、リポジトリに保存されない', async () => {
    const { repo, auth } = buildDeps();
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    await expect(signUp({ name: '', email: 'a@b.co', password: 'secret123' })).rejects.toThrow(
      InvalidCustomerError,
    );
    expect(repo.size()).toBe(0);
  });

  it('不正な email では Email.of が例外を投げ、リポジトリに保存されない', async () => {
    const { repo, auth } = buildDeps();
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    await expect(signUp({ name: 'a', email: 'invalid', password: 'secret123' })).rejects.toThrow(
      InvalidEmailError,
    );
    expect(repo.size()).toBe(0);
  });

  it('短いパスワードは Auth 側で拒否される（SignUpFailedError）', async () => {
    const { repo, auth } = buildDeps();
    const signUp = createSignUpCustomerUseCase(auth, repo, silentLogger);

    await expect(signUp({ name: 'a', email: 'ok@example.com', password: 'short' })).rejects.toThrow(
      SignUpFailedError,
    );
    expect(repo.size()).toBe(0);
  });
});
