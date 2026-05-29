import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '@/shared/infrastructure/logger';
import { NoopEventPublisher } from '@/shared/application/event-publisher';
import type { EventPublisher } from '@/shared/application/event-publisher';
import type { WebhookEvent } from '@/shared/domain/webhook-event';
import { createPlaceOrderUseCase } from './place-order.usecase';
import { InMemoryOrderRepository } from './__test-helpers__/in-memory-order.repository';
import {
  InvalidOrderError,
  InvalidOrderItemError,
  InsufficientStockError,
  CakeNotFoundInOrderError,
} from '../domain/order.errors';

const silentLogger = createSilentLogger();

const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAKE_A = '11111111-1111-4111-8111-111111111111';
const CAKE_B = '22222222-2222-4222-8222-222222222222';

const buildRepo = (
  seeds: Array<{ cakeId: string; price: number; stock: number }>,
): InMemoryOrderRepository => {
  const repo = new InMemoryOrderRepository();
  for (const seed of seeds) {
    repo.seedCake(seed);
  }
  return repo;
};

describe('place-order usecase', () => {
  describe('正常系', () => {
    it('1 件の明細で注文を確定できる（在庫減算 + 単価スナップショット）', async () => {
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 10 }]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);

      const order = await placeOrder({
        customerId: CUSTOMER,
        items: [{ cakeId: CAKE_A, quantity: 3 }],
      });

      expect(order.items).toHaveLength(1);
      expect(order.items[0]?.unitPrice).toBe(500); // スナップショット
      expect(order.totalAmount()).toBe(1500);
      expect(repo.getStock(CAKE_A)).toBe(7); // 10 - 3
    });

    it('複数明細の注文を確定できる', async () => {
      const repo = buildRepo([
        { cakeId: CAKE_A, price: 500, stock: 10 },
        { cakeId: CAKE_B, price: 750, stock: 5 },
      ]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);

      const order = await placeOrder({
        customerId: CUSTOMER,
        items: [
          { cakeId: CAKE_A, quantity: 2 }, // 1000
          { cakeId: CAKE_B, quantity: 1 }, // 750
        ],
      });

      expect(order.totalAmount()).toBe(1750);
      expect(repo.getStock(CAKE_A)).toBe(8);
      expect(repo.getStock(CAKE_B)).toBe(4);
    });

    it('OrderPlaced イベントが logger.info に渡される', async () => {
      const logger = createSilentLogger();
      const spy = vi.spyOn(logger, 'info');
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 10 }]);
      const placeOrder = createPlaceOrderUseCase(repo, logger, NoopEventPublisher);

      await placeOrder({
        customerId: CUSTOMER,
        items: [{ cakeId: CAKE_A, quantity: 2 }],
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'OrderPlaced',
          customerId: CUSTOMER,
          totalAmount: 1000,
          itemCount: 1,
        }),
        'OrderPlaced',
      );
    });

    it('EventPublisher.publish に order.placed WebhookEvent が渡される', async () => {
      // 注文確定後の副作用として webhook 配信用 publisher が呼ばれることを担保する。
      // payload は shared/domain/WebhookEvent shape（snake_case）に変換されているか
      // までを 1 か所で検証する（DTO 化忘れの retry を防ぐ）。
      const repo = buildRepo([
        { cakeId: CAKE_A, price: 500, stock: 10 },
        { cakeId: CAKE_B, price: 750, stock: 5 },
      ]);
      const publishSpy = vi.fn<EventPublisher['publish']>(() => Promise.resolve());
      const publisher: EventPublisher = { publish: publishSpy };
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, publisher);

      const order = await placeOrder({
        customerId: CUSTOMER,
        items: [
          { cakeId: CAKE_A, quantity: 2 },
          { cakeId: CAKE_B, quantity: 1 },
        ],
      });

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const event = publishSpy.mock.calls[0]?.[0] as WebhookEvent;
      expect(event.event_type).toBe('order.placed');
      expect(typeof event.event_id).toBe('string');
      expect(event.event_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(event.occurred_at).toBe(order.placedAt.toISOString());
      expect(event.data).toEqual({
        order_id: order.id.value,
        customer_id: CUSTOMER,
        items: [
          { cake_id: CAKE_A, quantity: 2, unit_price: 500 },
          { cake_id: CAKE_B, quantity: 1, unit_price: 750 },
        ],
        total_amount: 1750,
      });
    });

    it('publisher.publish が throw しても注文確定は成功扱い（副系で主系を巻き戻さない）', async () => {
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 10 }]);
      const publisher: EventPublisher = {
        publish: () => Promise.reject(new Error('webhook backend down')),
      };
      const logger = createSilentLogger();
      const warnSpy = vi.spyOn(logger, 'warn');
      const placeOrder = createPlaceOrderUseCase(repo, logger, publisher);

      const order = await placeOrder({
        customerId: CUSTOMER,
        items: [{ cakeId: CAKE_A, quantity: 1 }],
      });

      expect(order.totalAmount()).toBe(500);
      // 在庫は減算済み = 注文は完了している
      expect(repo.getStock(CAKE_A)).toBe(9);
      // 失敗は warn ログに残る（後追い調査できるように）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: order.id.value, message: 'webhook backend down' }),
        expect.stringContaining('publish に失敗'),
      );
    });

    it('items 0 件で repo.place 前に弾かれた場合、publisher は呼ばれない', async () => {
      const repo = buildRepo([]);
      const publishSpy = vi.fn<EventPublisher['publish']>(() => Promise.resolve());
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, { publish: publishSpy });
      await expect(placeOrder({ customerId: CUSTOMER, items: [] })).rejects.toThrow(
        InvalidOrderError,
      );
      expect(publishSpy).not.toHaveBeenCalled();
    });
  });

  describe('構造的不変条件', () => {
    it('items 0 件は InvalidOrderError', async () => {
      const repo = buildRepo([]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);
      await expect(placeOrder({ customerId: CUSTOMER, items: [] })).rejects.toThrow(
        InvalidOrderError,
      );
    });

    it('同一 cakeId が 2 行に分かれているのは InvalidOrderError', async () => {
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 10 }]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);
      await expect(
        placeOrder({
          customerId: CUSTOMER,
          items: [
            { cakeId: CAKE_A, quantity: 1 },
            { cakeId: CAKE_A, quantity: 2 },
          ],
        }),
      ).rejects.toThrow(InvalidOrderError);
    });
  });

  describe('入力バリデーション（VO 経由）', () => {
    it('customerId が UUID v4 でなければ InvalidOrderError', async () => {
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 10 }]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);
      await expect(
        placeOrder({
          customerId: 'not-a-uuid',
          items: [{ cakeId: CAKE_A, quantity: 1 }],
        }),
      ).rejects.toThrow(InvalidOrderError);
    });

    it('quantity が 0 だと InvalidOrderItemError', async () => {
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 10 }]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);
      await expect(
        placeOrder({
          customerId: CUSTOMER,
          items: [{ cakeId: CAKE_A, quantity: 0 }],
        }),
      ).rejects.toThrow(InvalidOrderItemError);
    });
  });

  describe('業務エラー（在庫 / 商品なし）', () => {
    it('在庫不足は InsufficientStockError（CONFLICT 409 にマッピングされる）', async () => {
      const repo = buildRepo([{ cakeId: CAKE_A, price: 500, stock: 2 }]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);
      await expect(
        placeOrder({
          customerId: CUSTOMER,
          items: [{ cakeId: CAKE_A, quantity: 3 }],
        }),
      ).rejects.toThrow(InsufficientStockError);
    });

    it('存在しない cakeId は CakeNotFoundInOrderError（NOT_FOUND 404）', async () => {
      const repo = buildRepo([]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);
      await expect(
        placeOrder({
          customerId: CUSTOMER,
          items: [{ cakeId: CAKE_A, quantity: 1 }],
        }),
      ).rejects.toThrow(CakeNotFoundInOrderError);
    });

    it('複数明細の一部が在庫不足のとき、他の明細の在庫も減らない（all-or-nothing）', async () => {
      const repo = buildRepo([
        { cakeId: CAKE_A, price: 500, stock: 10 },
        { cakeId: CAKE_B, price: 750, stock: 1 },
      ]);
      const placeOrder = createPlaceOrderUseCase(repo, silentLogger, NoopEventPublisher);

      await expect(
        placeOrder({
          customerId: CUSTOMER,
          items: [
            { cakeId: CAKE_A, quantity: 2 },
            { cakeId: CAKE_B, quantity: 5 }, // 在庫不足
          ],
        }),
      ).rejects.toThrow(InsufficientStockError);

      // CAKE_A の在庫が減っていないことを確認（all-or-nothing 担保）
      expect(repo.getStock(CAKE_A)).toBe(10);
      expect(repo.getStock(CAKE_B)).toBe(1);
    });
  });
});
