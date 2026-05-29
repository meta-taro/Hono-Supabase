import { describe, it, expect } from 'vitest';
import { createGetCakeUseCase } from './get-cake.usecase';
import { InMemoryCakeRepository } from './__test-helpers__/in-memory-cake.repository';
import { Cake } from '../domain/cake';
import { CakeNotFoundError } from '../domain/cake.errors';
import { InvalidCakeError } from '../domain/cake.errors';

const VALID_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('getCakeUseCase', () => {
  it('存在する Cake を id で取得する', async () => {
    const repo = new InMemoryCakeRepository();
    const cake = Cake.reconstruct({
      id: VALID_ID,
      name: 'モンブラン',
      price: 600,
      stock: 10,
      version: 1,
    });
    await repo.save(cake);
    const getCake = createGetCakeUseCase(repo);

    const found = await getCake({ cakeId: VALID_ID });

    expect(found.id.value).toBe(VALID_ID);
    expect(found.name).toBe('モンブラン');
    expect(found.version).toBe(1);
  });

  it('存在しない id は CakeNotFoundError(404)', async () => {
    const repo = new InMemoryCakeRepository();
    const getCake = createGetCakeUseCase(repo);

    await expect(getCake({ cakeId: VALID_ID })).rejects.toBeInstanceOf(CakeNotFoundError);
  });

  it('UUID でない id は InvalidCakeError(400)', async () => {
    const repo = new InMemoryCakeRepository();
    const getCake = createGetCakeUseCase(repo);

    await expect(getCake({ cakeId: 'not-uuid' })).rejects.toBeInstanceOf(InvalidCakeError);
  });
});
