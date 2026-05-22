import { describe, it, expect } from 'vitest';
import { createUpdateCakeStockUseCase } from './update-cake-stock.usecase';
import { InMemoryCakeRepository } from './__test-helpers__/in-memory-cake.repository';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { Cake } from '../domain/cake';
import { CakeNotFoundError, CakeVersionConflictError } from '../domain/cake.errors';
import { InvalidCakeError } from '../domain/cake.errors';

const VALID_ID = '550e8400-e29b-41d4-a716-446655440000';
const logger = createSilentLogger();

const seedCake = async (repo: InMemoryCakeRepository, version = 1): Promise<void> => {
  await repo.save(
    Cake.reconstruct({ id: VALID_ID, name: 'モンブラン', price: 600, stock: 10, version }),
  );
};

describe('updateCakeStockUseCase', () => {
  it('version 一致なら在庫を更新し、version を +1 した Cake を返す', async () => {
    const repo = new InMemoryCakeRepository();
    await seedCake(repo, 1);
    const updateStock = createUpdateCakeStockUseCase(repo, logger);

    const updated = await updateStock({ cakeId: VALID_ID, stock: 50, expectedVersion: 1 });

    expect(updated.stock).toBe(50);
    expect(updated.version).toBe(2);
    // 永続化も更新されている
    const reread = await repo.findById((await repo.findById(updated.id))!.id);
    expect(reread?.stock).toBe(50);
  });

  it('version 不一致なら CakeVersionConflictError(412)（在庫は変わらない）', async () => {
    const repo = new InMemoryCakeRepository();
    await seedCake(repo, 5);
    const updateStock = createUpdateCakeStockUseCase(repo, logger);

    // クライアントは version 4 のつもり（実際は 5 = 誰かが更新済み）
    await expect(
      updateStock({ cakeId: VALID_ID, stock: 50, expectedVersion: 4 }),
    ).rejects.toBeInstanceOf(CakeVersionConflictError);

    const reread = await repo.findById(
      Cake.reconstruct({ id: VALID_ID, name: 'x', price: 1, stock: 0, version: 1 }).id,
    );
    expect(reread?.stock).toBe(10); // 変わっていない
  });

  it('存在しない id は CakeNotFoundError(404)', async () => {
    const repo = new InMemoryCakeRepository();
    const updateStock = createUpdateCakeStockUseCase(repo, logger);

    await expect(
      updateStock({ cakeId: VALID_ID, stock: 50, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(CakeNotFoundError);
  });

  it('UUID でない id は InvalidCakeError(400)', async () => {
    const repo = new InMemoryCakeRepository();
    const updateStock = createUpdateCakeStockUseCase(repo, logger);

    await expect(
      updateStock({ cakeId: 'not-uuid', stock: 50, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(InvalidCakeError);
  });

  it('在庫が負なら InvalidCakeError(400)（domain 検証）', async () => {
    const repo = new InMemoryCakeRepository();
    await seedCake(repo, 1);
    const updateStock = createUpdateCakeStockUseCase(repo, logger);

    await expect(
      updateStock({ cakeId: VALID_ID, stock: -1, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(InvalidCakeError);
  });

  it('在庫 0（在庫切れ）への更新は許可する', async () => {
    const repo = new InMemoryCakeRepository();
    await seedCake(repo, 1);
    const updateStock = createUpdateCakeStockUseCase(repo, logger);

    const updated = await updateStock({ cakeId: VALID_ID, stock: 0, expectedVersion: 1 });
    expect(updated.stock).toBe(0);
  });
});
