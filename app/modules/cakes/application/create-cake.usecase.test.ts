import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { createCreateCakeUseCase } from './create-cake.usecase';
import { InMemoryCakeRepository } from './__test-helpers__/in-memory-cake.repository';
import { InvalidCakeError, InvalidPriceError } from '../domain/cake.errors';

// テスト用に出力を捨てる silent ロガー（AppLogger no-op 実装）
const silentLogger = createSilentLogger();

describe('createCakeUseCase', () => {
  it('正しい入力で Cake を生成し、リポジトリに保存される', async () => {
    const repo = new InMemoryCakeRepository();
    const createCake = createCreateCakeUseCase(repo, silentLogger);

    const cake = await createCake({ name: 'モンブラン', price: 600, stock: 10 });

    expect(cake.name).toBe('モンブラン');
    expect(cake.price.value).toBe(600);
    expect(cake.stock).toBe(10);
    expect(repo.size()).toBe(1);
  });

  it('生成された Cake は list() で取得できる', async () => {
    const repo = new InMemoryCakeRepository();
    const createCake = createCreateCakeUseCase(repo, silentLogger);

    await createCake({ name: 'ガトーショコラ', price: 700, stock: 5 });
    const page = await repo.list({ limit: 20 });

    expect(page.cakes).toHaveLength(1);
    expect(page.cakes[0]?.name).toBe('ガトーショコラ');
  });

  it('成功時に info ログを出力する', async () => {
    const repo = new InMemoryCakeRepository();
    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy } as unknown as Parameters<
      typeof createCreateCakeUseCase
    >[1];
    const createCake = createCreateCakeUseCase(repo, fakeLogger);

    const cake = await createCake({ name: 'ショートケーキ', price: 500, stock: 8 });

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith(
      { cakeId: cake.id.value, name: 'ショートケーキ' },
      'Cake created',
    );
  });

  it('不正な name では Cake.create が例外を投げ、保存されない', async () => {
    const repo = new InMemoryCakeRepository();
    const createCake = createCreateCakeUseCase(repo, silentLogger);

    await expect(createCake({ name: '', price: 600, stock: 1 })).rejects.toThrow(InvalidCakeError);
    expect(repo.size()).toBe(0);
  });

  it('不正な price では Price.of が例外を投げ、保存されない', async () => {
    const repo = new InMemoryCakeRepository();
    const createCake = createCreateCakeUseCase(repo, silentLogger);

    await expect(createCake({ name: 'a', price: 0, stock: 1 })).rejects.toThrow(InvalidPriceError);
    expect(repo.size()).toBe(0);
  });
});
