import { describe, it, expect } from 'vitest';
import { createListCakesUseCase } from './list-cakes.usecase';
import { InMemoryCakeRepository } from './__test-helpers__/in-memory-cake.repository';
import { Cake } from '../domain/cake';

describe('listCakesUseCase', () => {
  it('リポジトリが空のときは空配列を返す', async () => {
    const repo = new InMemoryCakeRepository();
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes();

    expect(result).toEqual([]);
  });

  it('保存済みのケーキをすべて返す', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'モンブラン', price: 600, stock: 10 }));
    await repo.save(Cake.create({ name: 'ガトーショコラ', price: 700, stock: 5 }));
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes();

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(['ガトーショコラ', 'モンブラン']);
  });
});
