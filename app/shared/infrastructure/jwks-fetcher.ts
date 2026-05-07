// ---------------------------------------------------------------------------
// JwksFetcher port
//   Supabase の JWKS（公開鍵セット）を取得するための fetch 互換関数を抽象化する。
//
//   なぜ port を切るのか:
//     jose の createRemoteJWKSet は内部で fetch を使って JWKS を取りにいく。
//     Node では「globalThis.fetch を呼んで jose 内蔵キャッシュに任せる」で十分だが、
//     Cloudflare Workers では cold start が頻発するため、リクエスト跨ぎで
//     Cache API（caches.default）にキャッシュしたい。
//
//   port を切る粒度:
//     fetch そのものを抽象化する（jwtVerify 全体ではなく）。
//     - jose 自体は Web 標準ベースで Workers でも動くため、検証ロジック層の
//       抽象化は不要。
//     - jose v6 の createRemoteJWKSet は `[customFetch]` で fetch 関数を
//       差し替えられるため、ちょうどここが port-adapter の境界になる。
//
//   adapter:
//     - createNodeJwksFetcher: globalThis.fetch を素通し
//     - createWorkersJwksFetcher: Cache API + ctx.waitUntil で SWR 的に更新
// ---------------------------------------------------------------------------

// 型を Web 標準の `globalThis.fetch` に揃えることで、tsconfig の lib に DOM が
// 入っていない環境でも `@types/node` が提供する fetch の型をそのまま使える。
// jose の `[customFetch]` も同形のシグネチャを期待する。
export interface JwksFetcher {
  fetch: typeof globalThis.fetch;
}

// ExecutionContext.waitUntil の最小契約。
//   `@cloudflare/workers-types` の ExecutionContext も structurally 互換。
//   Workers 型をプロジェクト全体に取り込まずに済ませるための狭い port。
export interface ExecCtxLike {
  waitUntil(promise: Promise<unknown>): void;
}

// JwksFetcherProvider: per-request に fetcher を組み立てるための関数。
//   Node では ctx 不要（毎回同じ fetcher を返してよい）。
//   Workers では ctx ごとに Cache API への waitUntil を持つ fetcher を返す。
export type JwksFetcherProvider = (ctx?: ExecCtxLike) => JwksFetcher;

// Node 実装: グローバル fetch にそのまま委譲。
//   Node 22 は標準で undici 由来の fetch を持つ。jose 側の jwks_uri キャッシュ
//   （メモリ）に乗るので、これだけで実用上の性能は出る。
export const createNodeJwksFetcher = (): JwksFetcher => ({
  fetch: (input, init) => globalThis.fetch(input, init),
});

// ---------------------------------------------------------------------------
// Workers 実装
//   Cache API（caches.default）に JWKS レスポンスを乗せ、ctx.waitUntil で
//   バックグラウンド更新する Stale-While-Revalidate 戦略。
//
//   なぜこの戦略か:
//     - JWKS は数 KB だが頻繁には変わらない。毎リクエスト fetch すると
//       Supabase 側に余計な負荷をかける + p99 レイテンシが伸びる。
//     - jose 内蔵のメモリキャッシュは isolate 単位で揮発する（cold start で消える）。
//     - Workers の `caches.default` は **同一データセンター内**で永続化され、
//       isolate 跨ぎで再利用できる。SWR にすればキー回転にも自然に追従。
//
//   テスト容易性のための DI:
//     cache / ctx / fetch をすべて引数で受け取る。
//     本番は `caches.default` と Workers ランタイムの ExecutionContext を渡し、
//     テストでは Cache interface を満たす fake と spy 関数を渡す。
//
//   キャッシュキー:
//     `Cache.match(request)` は Request オブジェクトでマッチさせる。
//     URL のみの GET リクエストを Request にして key にする（Cache API の規約）。
// ---------------------------------------------------------------------------

// Cache.match / Cache.put が必要とする最小契約。
//   Workers の Cache interface は他にも delete/keys 等を持つが、本 fetcher では
//   この 2 つだけ使う。テスト用 fake が小さくて済むよう絞り込んでいる。
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface WorkersJwksFetcherOptions {
  cache: CacheLike;
  ctx: ExecCtxLike;
  // テスト差し替え用に fetch も DI 可能にする。本番は globalThis.fetch を渡す。
  fetch?: typeof globalThis.fetch;
}

const toRequest = (input: Parameters<typeof globalThis.fetch>[0]): Request => {
  // Cache API の key は Request である必要がある（URL 文字列ではマッチしない）。
  if (input instanceof Request) return new Request(input.url, { method: 'GET' });
  if (input instanceof URL) return new Request(input.toString(), { method: 'GET' });
  return new Request(String(input), { method: 'GET' });
};

export const createWorkersJwksFetcher = (
  options: WorkersJwksFetcherOptions,
): JwksFetcher => {
  const { cache, ctx } = options;
  const upstreamFetch = options.fetch ?? globalThis.fetch;

  return {
    fetch: async (input, init) => {
      const cacheKey = toRequest(input);

      // 1) Cache hit → 即返す + 裏で更新（SWR）
      const cached = await cache.match(cacheKey);
      if (cached) {
        ctx.waitUntil(
          (async () => {
            // 失敗してもログを残さず黙って捨てる: 次のリクエストで再試行されるし、
            // 既存キャッシュは生きているので可用性は維持される。
            try {
              const fresh = await upstreamFetch(input, init);
              if (fresh.ok) {
                await cache.put(cacheKey, fresh.clone());
              }
            } catch {
              // intentional swallow — SWR の裏取得失敗は致命ではない
            }
          })(),
        );
        return cached;
      }

      // 2) Cache miss → origin fetch + waitUntil で put
      const fresh = await upstreamFetch(input, init);
      if (fresh.ok) {
        // response.clone() を put 側に渡し、本体は呼び出し元（jose）に返す。
        // Body は一度しか読めないため clone が必須。
        ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
      }
      return fresh;
    },
  };
};
