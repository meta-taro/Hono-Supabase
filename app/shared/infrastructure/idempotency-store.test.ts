import { describe, it, expect } from 'vitest';
import { InMemoryIdempotencyStore } from './idempotency-store';

// ---------------------------------------------------------------------------
// InMemoryIdempotencyStore は本番の SupabaseIdempotencyStore と同じ contract を
// 満たす test double。middleware の単体・統合テストでも使い回す。
// ここでは store 単体の状態遷移（inserted → completed / replay / in_progress / mismatch /
// expired 上書き）が仕様通り動くことを担保する。
// ---------------------------------------------------------------------------

const baseRecord = {
  key: 'k1',
  ownerType: 'user' as const,
  ownerId: 'u1',
  scope: 'POST /v1/orders',
  requestHash: 'hash-a',
};

describe('InMemoryIdempotencyStore', () => {
  it('初回 tryReserve は inserted を返す', async () => {
    const store = new InMemoryIdempotencyStore();
    const outcome = await store.tryReserve(baseRecord);
    expect(outcome.kind).toBe('inserted');
  });

  it('完了済みの同じ key+body で tryReserve すると replay を返す', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryReserve(baseRecord);
    await store.complete(baseRecord, { status: 201, body: { id: 'o1' } });

    const outcome = await store.tryReserve(baseRecord);
    expect(outcome.kind).toBe('replay');
    if (outcome.kind === 'replay') {
      expect(outcome.status).toBe(201);
      expect(outcome.body).toEqual({ id: 'o1' });
    }
  });

  it('完了済みの同じ key で body が違うと mismatch を返す', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryReserve(baseRecord);
    await store.complete(baseRecord, { status: 201, body: { id: 'o1' } });

    const outcome = await store.tryReserve({ ...baseRecord, requestHash: 'hash-b' });
    expect(outcome.kind).toBe('mismatch');
  });

  it('未完了の同じ key で tryReserve すると in_progress を返す', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryReserve(baseRecord);

    const outcome = await store.tryReserve(baseRecord);
    expect(outcome.kind).toBe('in_progress');
  });

  it('owner_type が違えば衝突せずに inserted を返す（user vs ip 隔離）', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryReserve(baseRecord);

    const outcome = await store.tryReserve({ ...baseRecord, ownerType: 'ip', ownerId: '1.2.3.4' });
    expect(outcome.kind).toBe('inserted');
  });

  it('owner_id が違えば衝突せずに inserted を返す（user 単位の隔離）', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryReserve(baseRecord);

    const outcome = await store.tryReserve({ ...baseRecord, ownerId: 'u2' });
    expect(outcome.kind).toBe('inserted');
  });

  it('scope が違えば衝突せずに inserted を返す（POST /v1/orders と POST /v1/customers の隔離）', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.tryReserve(baseRecord);

    const outcome = await store.tryReserve({ ...baseRecord, scope: 'POST /v1/customers' });
    expect(outcome.kind).toBe('inserted');
  });

  it('expired 行は上書きして inserted を返す', async () => {
    let nowMs = 1000;
    const store = new InMemoryIdempotencyStore({
      now: () => nowMs,
      ttlMs: 60_000,
    });
    await store.tryReserve(baseRecord);
    await store.complete(baseRecord, { status: 201, body: { id: 'old' } });

    // 1 時間進める → expired
    nowMs += 60 * 60 * 1000;

    const outcome = await store.tryReserve({ ...baseRecord, requestHash: 'hash-new' });
    expect(outcome.kind).toBe('inserted');
  });

  it('complete は未予約の key には何もしない（noop で例外を投げない）', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(
      store.complete(baseRecord, { status: 200, body: { ok: true } }),
    ).resolves.toBeUndefined();
  });
});
