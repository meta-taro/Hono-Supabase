import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseIdempotencyStore } from './supabase-idempotency-store';
import type { IdempotencyRecord } from './idempotency-store';
import { loadEnv, type RawEnv } from '@/shared/http/env';

// ---------------------------------------------------------------------------
// 実 Supabase ローカルに対する SupabaseIdempotencyStore の挙動検証。
//   - 同じ key+body の再送 → replay
//   - 同じ key で違う body → mismatch
//   - 進行中 → in_progress
//   - owner_type / owner_id / scope の隔離
//   - expired 行の上書き
// `supabase start` が必要。`vitest-pool-workers` の bindings 経由で env を受け取る。
// ---------------------------------------------------------------------------

const SCOPE_PREFIX = '__test_idemp_';

const env = loadEnv(workerEnv as unknown as RawEnv);
const sbAdmin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cleanupTestRows = async (): Promise<void> => {
  const { error } = await sbAdmin
    .from('idempotency_keys')
    .delete()
    .like('scope', `${SCOPE_PREFIX}%`);
  if (error) {
    throw new Error(`テストデータ掃除に失敗: ${error.message}`);
  }
};

const buildRecord = (over: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({
  key: 'k1',
  ownerType: 'user',
  ownerId: 'u1',
  scope: `${SCOPE_PREFIX}orders`,
  requestHash: 'hash-a',
  ...over,
});

describe('SupabaseIdempotencyStore（実 Supabase ローカルに接続）', () => {
  beforeEach(cleanupTestRows);
  afterAll(cleanupTestRows);

  const store = new SupabaseIdempotencyStore(sbAdmin);

  it('初回 tryReserve は inserted を返す', async () => {
    const outcome = await store.tryReserve(buildRecord());
    expect(outcome.kind).toBe('inserted');
  });

  it('完了後の同じ key+body は replay を返す', async () => {
    const r = buildRecord();
    await store.tryReserve(r);
    await store.complete(r, { status: 201, body: { id: 'o1' } });

    const outcome = await store.tryReserve(r);
    expect(outcome.kind).toBe('replay');
    if (outcome.kind === 'replay') {
      expect(outcome.status).toBe(201);
      expect(outcome.body).toEqual({ id: 'o1' });
    }
  });

  it('未完了の同じ key で再 tryReserve すると in_progress', async () => {
    const r = buildRecord();
    await store.tryReserve(r);
    const outcome = await store.tryReserve(r);
    expect(outcome.kind).toBe('in_progress');
  });

  it('同じ key で異なる body を予約しようとすると mismatch', async () => {
    const r = buildRecord();
    await store.tryReserve(r);
    await store.complete(r, { status: 201, body: { id: 'o1' } });

    const outcome = await store.tryReserve({ ...r, requestHash: 'hash-b' });
    expect(outcome.kind).toBe('mismatch');
  });

  it('owner_type が違えば衝突せず inserted（user と ip の隔離）', async () => {
    await store.tryReserve(buildRecord());
    const outcome = await store.tryReserve(buildRecord({ ownerType: 'ip', ownerId: '1.2.3.4' }));
    expect(outcome.kind).toBe('inserted');
  });

  it('scope が違えば衝突せず inserted（POST /v1/orders と POST /v1/customers の隔離）', async () => {
    await store.tryReserve(buildRecord());
    const outcome = await store.tryReserve(buildRecord({ scope: `${SCOPE_PREFIX}customers` }));
    expect(outcome.kind).toBe('inserted');
  });

  it('complete は最初の completed が勝つ（2 回目以降の上書きは無視）', async () => {
    const r = buildRecord();
    await store.tryReserve(r);
    await store.complete(r, { status: 201, body: { id: 'first' } });
    await store.complete(r, { status: 500, body: { id: 'second' } });

    const outcome = await store.tryReserve(r);
    expect(outcome.kind).toBe('replay');
    if (outcome.kind === 'replay') {
      expect(outcome.status).toBe(201);
      expect(outcome.body).toEqual({ id: 'first' });
    }
  });

  it('expired 行は上書きして inserted を返す', async () => {
    // 行を強制的に expired にするため、expires_at を過去にして直接挿入する。
    const r = buildRecord({ key: 'k-expired' });
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const { error: insertErr } = await sbAdmin.from('idempotency_keys').insert({
      key: r.key,
      owner_type: r.ownerType,
      owner_id: r.ownerId,
      scope: r.scope,
      request_hash: 'old-hash',
      status: 'completed',
      response_status: 200,
      response_body: { stale: true },
      expires_at: pastIso,
    });
    expect(insertErr).toBeNull();

    const outcome = await store.tryReserve({ ...r, requestHash: 'new-hash' });
    expect(outcome.kind).toBe('inserted');
  });
});
