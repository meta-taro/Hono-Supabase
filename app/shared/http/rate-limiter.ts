// ---------------------------------------------------------------------------
// Rate Limit ポート（Phase 10 Step 5）
//
//   Cloudflare Workers Rate Limiting binding と shape を揃えた最小契約。
//   Workers binding（env.LIMITER_*）はこの interface をそのまま満たすため、
//   middleware や DI 経由で「実 binding」「fake」のどちらでも差し替え可能。
//
//   なぜ Cloudflare の shape をそのまま採用するか:
//     1. Workers binding を `satisfies RateLimiter` だけで適合させられる（薄い wrapper も不要）
//     2. 戻り値が { success } のみで簡素 — middleware 側で 429 と Retry-After を組み立てる
//        責務を一本化できる（CLAUDE.md の「ロジックは middleware に寄せる」方針と整合）
//
//   period（fixed window の長さ）はこの interface には含めない。
//   period は wrangler.toml の [ratelimits.simple] で binding に焼き込まれており、
//   呼び出し側からは「いま何秒のウィンドウか」を意識せずに limit() を呼ぶだけで済む。
//   middleware が「自分が紐づく binding の period」を別経路で知って Retry-After に
//   反映する設計（→ rate-limit.middleware.ts）。
// ---------------------------------------------------------------------------

export interface RateLimitArgs {
  key: string;
}

export interface RateLimitOutcome {
  success: boolean;
}

export interface RateLimiter {
  limit(args: RateLimitArgs): Promise<RateLimitOutcome>;
}

// ---------------------------------------------------------------------------
// InMemoryRateLimiter: node-unit プールでの単体テスト・ローカル開発用 fake。
//
//   fixed window 方式を Map で模す。Workers binding の挙動を「観察可能な範囲で」
//   再現するためのテストダブルで、本番経路では使わない。
//
//   now を注入可能にしているのは、テストで時間を進めずに「ウィンドウ越境」シナリオを
//   再現するため。実時間に依存しないことで CI のフレーキーさを避ける。
// ---------------------------------------------------------------------------

interface WindowState {
  count: number;
  windowStart: number;
}

export interface InMemoryRateLimiterOptions {
  limit: number;
  periodSec: number;
  now?: () => number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly limitCount: number;
  private readonly periodMs: number;
  private readonly now: () => number;
  private readonly state = new Map<string, WindowState>();

  constructor(options: InMemoryRateLimiterOptions) {
    this.limitCount = options.limit;
    this.periodMs = options.periodSec * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  limit({ key }: RateLimitArgs): Promise<RateLimitOutcome> {
    const now = this.now();
    const entry = this.state.get(key);

    if (!entry || now - entry.windowStart >= this.periodMs) {
      // 新規 key、またはウィンドウを越えた → 1 カウントで開始。
      this.state.set(key, { count: 1, windowStart: now });
      return Promise.resolve({ success: this.limitCount >= 1 });
    }

    if (entry.count >= this.limitCount) {
      return Promise.resolve({ success: false });
    }

    entry.count += 1;
    return Promise.resolve({ success: true });
  }
}
