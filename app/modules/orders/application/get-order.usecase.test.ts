import { describe, it, expect } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { createGetOrderUseCase } from './get-order.usecase';
import { createPlaceOrderUseCase } from './place-order.usecase';
import { InMemoryOrderRepository } from './__test-helpers__/in-memory-order.repository';
import {
  InvalidOrderError,
  OrderNotFoundError,
} from '../domain/order.errors';

const silentLogger = createSilentLogger();

const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAKE_A = '11111111-1111-4111-8111-111111111111';

describe('get-order usecase', () => {
  it('保存済み注文を取得できる', async () => {
    const repo = new InMemoryOrderRepository();
    repo.seedCake({ cakeId: CAKE_A, price: 500, stock: 10 });

    const placeOrder = createPlaceOrderUseCase(repo, silentLogger);
    const placed = await placeOrder({
      customerId: CUSTOMER,
      items: [{ cakeId: CAKE_A, quantity: 2 }],
    });

    const getOrder = createGetOrderUseCase(repo);
    const found = await getOrder({ orderId: placed.id.value });

    expect(found.id.equals(placed.id)).toBe(true);
    expect(found.totalAmount()).toBe(1000);
  });

  it('存在しない orderId は OrderNotFoundError', async () => {
    const repo = new InMemoryOrderRepository();
    const getOrder = createGetOrderUseCase(repo);
    await expect(
      getOrder({ orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ).rejects.toThrow(OrderNotFoundError);
  });

  it('UUID v4 でない orderId は InvalidOrderError', async () => {
    const repo = new InMemoryOrderRepository();
    const getOrder = createGetOrderUseCase(repo);
    await expect(getOrder({ orderId: 'not-a-uuid' })).rejects.toThrow(
      InvalidOrderError,
    );
  });
});
