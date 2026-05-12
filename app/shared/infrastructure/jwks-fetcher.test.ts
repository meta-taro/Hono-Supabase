import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createNodeJwksFetcher,
  createWorkersJwksFetcher,
  type CacheLike,
  type ExecCtxLike,
} from './jwks-fetcher';

// ---------------------------------------------------------------------------
// JwksFetcher は jose の createRemoteJWKSet({ [customFetch]: ... }) に渡す
// fetch 互換関数を抽象化する port。Phase 7 の Workers 化で Cache API 版に
// 差し替えるためのフックポイント。
//
// Node 実装は globalThis.fetch を素通しするだけで、jose 内蔵のメモリキャッシュに
// 任せる（Node プロセスは長生きするため、これで十分機能する）。
//
// このテストは「Node fetcher が真に薄い委譲であること」を契約として固定する。
// 何かを足したくなったら、それは Workers fetcher 側の責務（Cache API 等）に置く。
// ---------------------------------------------------------------------------

describe('createNodeJwksFetcher', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('JwksFetcher 形を満たす（fetch メソッドを持つ）', () => {
    const fetcher = createNodeJwksFetcher();
    expect(typeof fetcher.fetch).toBe('function');
  });

  it('globalThis.fetch を呼び出して結果をそのまま返す', async () => {
    const expectedResponse = new Response('{"keys":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const spy = vi.fn().mockResolvedValue(expectedResponse);
    globalThis.fetch = spy as typeof fetch;

    const fetcher = createNodeJwksFetcher();
    const result = await fetcher.fetch('https://example.com/jwks.json');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://example.com/jwks.json', undefined);
    expect(result).toBe(expectedResponse);
  });

  it('init オプションをそのまま委譲する', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('{}'));
    globalThis.fetch = spy as typeof fetch;

    const fetcher = createNodeJwksFetcher();
    const init = { method: 'GET', headers: { accept: 'application/json' } };
    await fetcher.fetch('https://example.com/jwks.json', init);

    expect(spy).toHaveBeenCalledWith('https://example.com/jwks.json', init);
  });

  it('URL オブジェクトもそのまま渡せる', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('{}'));
    globalThis.fetch = spy as typeof fetch;

    const fetcher = createNodeJwksFetcher();
    const url = new URL('https://example.com/jwks.json');
    await fetcher.fetch(url);

    expect(spy).toHaveBeenCalledWith(url, undefined);
  });
});

// ---------------------------------------------------------------------------
// createWorkersJwksFetcher
//   Cache API + ctx.waitUntil で Stale-While-Revalidate する fetcher。
//   テストでは CacheLike / ExecCtxLike を満たす最小の fake を渡し、
//   キャッシュ ヒット/ミスの分岐 + waitUntil の発火タイミングを検証する。
// ---------------------------------------------------------------------------

interface FakeCache extends CacheLike {
  matchCalls: Request[];
  putCalls: Array<{ request: Request; response: Response }>;
}

const createFakeCache = (initial?: { request: Request; response: Response }): FakeCache => {
  const store = new Map<string, Response>();
  if (initial) store.set(initial.request.url, initial.response);
  return {
    matchCalls: [],
    putCalls: [],
    async match(request) {
      this.matchCalls.push(request);
      return store.get(request.url);
    },
    async put(request, response) {
      this.putCalls.push({ request, response });
      store.set(request.url, response);
    },
  };
};

const createFakeCtx = (): ExecCtxLike & { waitUntilPromises: Promise<unknown>[] } => {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntilPromises: promises,
    waitUntil(promise) {
      promises.push(promise);
    },
  };
};

const URL_JWKS = 'https://project.supabase.co/auth/v1/.well-known/jwks.json';

describe('createWorkersJwksFetcher', () => {
  it('cache miss のとき origin fetch して、結果を返しつつ waitUntil で put する', async () => {
    const cache = createFakeCache();
    const ctx = createFakeCtx();
    const fresh = new Response('{"keys":[1]}', { status: 200 });
    const upstream = vi.fn().mockResolvedValue(fresh);

    const fetcher = createWorkersJwksFetcher({ cache, ctx, fetch: upstream as typeof fetch });
    const result = await fetcher.fetch(URL_JWKS);

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(result).toBe(fresh);
    // waitUntil 経由の put は同期登録されるが、await が必要
    await Promise.all(ctx.waitUntilPromises);
    expect(cache.putCalls).toHaveLength(1);
    expect(cache.putCalls[0]?.request.url).toBe(URL_JWKS);
  });

  it('cache hit のときは即キャッシュを返し、SWR 更新は ctx.waitUntil に登録される', async () => {
    const cachedResponse = new Response('{"keys":[1]}', { status: 200 });
    const cache = createFakeCache({
      request: new Request(URL_JWKS, { method: 'GET' }),
      response: cachedResponse,
    });
    const ctx = createFakeCtx();
    const updatedResponse = new Response('{"keys":[2]}', { status: 200 });
    const upstream = vi.fn().mockResolvedValue(updatedResponse);

    const fetcher = createWorkersJwksFetcher({ cache, ctx, fetch: upstream as typeof fetch });
    const result = await fetcher.fetch(URL_JWKS);

    // 契約 1: 呼び出し元には cache がそのまま返る（origin fetch を await しない）
    expect(result).toBe(cachedResponse);
    // 契約 2: 裏更新は ctx.waitUntil に登録されている（Workers ランタイムが寿命を保証）
    expect(ctx.waitUntilPromises).toHaveLength(1);

    // waitUntil の Promise を解決させると、裏で origin fetch + put が走り終わる
    await Promise.all(ctx.waitUntilPromises);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cache.putCalls).toHaveLength(1);
  });

  it('origin fetch が非 2xx のときは put しない（壊れた応答をキャッシュしない）', async () => {
    const cache = createFakeCache();
    const ctx = createFakeCtx();
    const errorResponse = new Response('Bad Gateway', { status: 502 });
    const upstream = vi.fn().mockResolvedValue(errorResponse);

    const fetcher = createWorkersJwksFetcher({ cache, ctx, fetch: upstream as typeof fetch });
    const result = await fetcher.fetch(URL_JWKS);

    expect(result).toBe(errorResponse);
    await Promise.all(ctx.waitUntilPromises);
    expect(cache.putCalls).toHaveLength(0);
  });

  it('SWR 中の origin fetch 失敗は黙って捨てる（キャッシュは生きているので可用性は維持）', async () => {
    const cachedResponse = new Response('{"keys":[1]}', { status: 200 });
    const cache = createFakeCache({
      request: new Request(URL_JWKS, { method: 'GET' }),
      response: cachedResponse,
    });
    const ctx = createFakeCtx();
    const upstream = vi.fn().mockRejectedValue(new Error('network down'));

    const fetcher = createWorkersJwksFetcher({ cache, ctx, fetch: upstream as typeof fetch });
    const result = await fetcher.fetch(URL_JWKS);

    expect(result).toBe(cachedResponse);
    // waitUntil の中で握りつぶされ、test runner にエラーが伝播しない
    await expect(Promise.all(ctx.waitUntilPromises)).resolves.toBeDefined();
    expect(cache.putCalls).toHaveLength(0);
  });

  it('options.fetch 未指定のときは globalThis.fetch を使う', async () => {
    const realFetch = globalThis.fetch;
    const fresh = new Response('{"keys":[]}', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(fresh) as typeof fetch;
    try {
      const cache = createFakeCache();
      const ctx = createFakeCtx();
      const fetcher = createWorkersJwksFetcher({ cache, ctx });

      const result = await fetcher.fetch(URL_JWKS);
      expect(result).toBe(fresh);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
