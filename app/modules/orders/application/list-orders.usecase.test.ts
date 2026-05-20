import { describe, it, expect } from 'vitest';
import { createListOrdersUseCase } from './list-orders.usecase';
import { InMemoryOrderRepository } from './__test-helpers__/in-memory-order.repository';
import { InvalidOrderError } from '../domain/order.errors';

const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CUSTOMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAKE_A = '11111111-1111-4111-8111-111111111111';

// 辞書順で並ぶ注文 ID を組み立てる（id DESC の tiebreaker を検証するため）。
const oid = (suffix: string): string => `${suffix}-0000-4000-8000-000000000000`;

const buildRepo = (
  seeds: Array<{ id: string; customerId: string; placedAt: string }>,
): InMemoryOrderRepository => {
  const repo = new InMemoryOrderRepository();
  for (const seed of seeds) {
    repo.seedOrder({
      id: seed.id,
      customerId: seed.customerId,
      placedAt: new Date(seed.placedAt),
      items: [{ cakeId: CAKE_A, quantity: 1, unitPrice: 500 }],
    });
  }
  return repo;
};

describe('list-orders usecase', () => {
  it('リポジトリが空のときは空ページを返す', async () => {
    const repo = new InMemoryOrderRepository();
    const listOrders = createListOrdersUseCase(repo);

    const page = await listOrders({ customerId: CUSTOMER, limit: 20 });

    expect(page.orders).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it('本人の注文だけを新しい順（placed_at DESC）で返す', async () => {
    const repo = buildRepo([
      { id: oid('a0000001'), customerId: CUSTOMER, placedAt: '2026-01-01T00:00:00.000Z' },
      { id: oid('a0000002'), customerId: CUSTOMER, placedAt: '2026-01-03T00:00:00.000Z' },
      { id: oid('a0000003'), customerId: CUSTOMER, placedAt: '2026-01-02T00:00:00.000Z' },
      // 別人の注文は混ざらない（多重防御）
      { id: oid('b0000001'), customerId: OTHER_CUSTOMER, placedAt: '2026-01-04T00:00:00.000Z' },
    ]);
    const listOrders = createListOrdersUseCase(repo);

    const page = await listOrders({ customerId: CUSTOMER, limit: 20 });

    expect(page.orders.map((o) => o.placedAt.toISOString())).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(page.nextCursor).toBeNull(); // 全件 1 ページに収まる
  });

  it('placed_at 同値のときは id DESC で安定ソートする', async () => {
    const sameTime = '2026-01-01T00:00:00.000Z';
    const repo = buildRepo([
      { id: oid('a0000001'), customerId: CUSTOMER, placedAt: sameTime },
      { id: oid('a0000003'), customerId: CUSTOMER, placedAt: sameTime },
      { id: oid('a0000002'), customerId: CUSTOMER, placedAt: sameTime },
    ]);
    const listOrders = createListOrdersUseCase(repo);

    const page = await listOrders({ customerId: CUSTOMER, limit: 20 });

    // 同時刻なので id 降順（a0000003 → a0000002 → a0000001）
    expect(page.orders.map((o) => o.id.value)).toEqual([
      oid('a0000003'),
      oid('a0000002'),
      oid('a0000001'),
    ]);
  });

  it('limit を超えると nextCursor を返し、次ページが続きから取れる', async () => {
    const repo = buildRepo([
      { id: oid('a0000001'), customerId: CUSTOMER, placedAt: '2026-01-01T00:00:00.000Z' },
      { id: oid('a0000002'), customerId: CUSTOMER, placedAt: '2026-01-02T00:00:00.000Z' },
      { id: oid('a0000003'), customerId: CUSTOMER, placedAt: '2026-01-03T00:00:00.000Z' },
    ]);
    const listOrders = createListOrdersUseCase(repo);

    // 1 ページ目: limit=2 → 新しい 2 件 + nextCursor
    const page1 = await listOrders({ customerId: CUSTOMER, limit: 2 });
    expect(page1.orders.map((o) => o.placedAt.toISOString())).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    ]);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.nextCursor?.placedAt).toBe('2026-01-02T00:00:00.000Z');

    // 2 ページ目: after で続きから（残り 1 件、nextCursor は null）
    const page2 = await listOrders({
      customerId: CUSTOMER,
      limit: 2,
      after: page1.nextCursor ?? undefined,
    });
    expect(page2.orders.map((o) => o.placedAt.toISOString())).toEqual(['2026-01-01T00:00:00.000Z']);
    expect(page2.nextCursor).toBeNull();
  });

  it('ちょうど limit 件で終わるとき nextCursor は null（余分な空ページを作らない）', async () => {
    const repo = buildRepo([
      { id: oid('a0000001'), customerId: CUSTOMER, placedAt: '2026-01-01T00:00:00.000Z' },
      { id: oid('a0000002'), customerId: CUSTOMER, placedAt: '2026-01-02T00:00:00.000Z' },
    ]);
    const listOrders = createListOrdersUseCase(repo);

    const page = await listOrders({ customerId: CUSTOMER, limit: 2 });

    expect(page.orders).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('customerId が UUID v4 でなければ InvalidOrderError', async () => {
    const repo = new InMemoryOrderRepository();
    const listOrders = createListOrdersUseCase(repo);

    await expect(listOrders({ customerId: 'not-a-uuid', limit: 20 })).rejects.toThrow(
      InvalidOrderError,
    );
  });
});
