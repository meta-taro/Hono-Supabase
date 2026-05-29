// ---------------------------------------------------------------------------
// metrics (Phase 9 Step 4)
//   Workers Analytics Engine への「1 リクエスト = 1 データポイント」書き込みを抽象化する。
//
//   なぜ logger と同じ抽象化を取るか:
//     - 共通モジュール（本ファイル）は Workers 型 (AnalyticsEngineDataset) に
//       直接依存しない。triple-slash reference は index.workers.ts でだけ効かせる。
//     - ローカル開発（Node）/ テストでは createNoopMetricsRecorder で no-op に。
//       wrangler dev でも Analytics Engine binding は実書き込みされないので、
//       実機検証は staging deploy 後の Cloudflare Dashboard / SQL API でだけ可能。
//
//   blob / double / index の割り当て:
//     - blobs(string[]): 最大 20 個・各 5KB
//         1: method        ('GET' / 'POST' / 'PUT' / 'DELETE' / 'PATCH' 等)
//         2: route         (Hono c.req.routePath。例 '/v1/orders/:id'。正規化済み)
//         3: status_class  ('1xx' / '2xx' / '3xx' / '4xx' / '5xx')
//         4: env           ('development' / 'staging' / 'production' / 'test')
//         5: app_version   (Workers では version_metadata の id、それ以外は 'local')
//     - doubles(number[]): 最大 20 個
//         1: duration_ms   (accessLog と同じ「入口→出口」の経過時間)
//     - indexes(string[]): 1 個まで・96 bytes
//         status_class     (SQL WHERE で最も粗い切り口で絞る用)
//
//   PII を入れない方針:
//     - userId / email / requestId などはここに乗せない (Analytics Engine の 90 日
//       保持でも入れない)。requestId はログ側で十分追跡できる。
//
//   route の正規化:
//     - 生 path (`/v1/orders/abc-123`) を入れると uuid 分カーディナリティ爆発する。
//       呼び出し側 (access-log.middleware.ts) で c.req.routePath を渡してもらう。
// ---------------------------------------------------------------------------

// Workers Analytics Engine の writeDataPoint シグネチャ。
// @cloudflare/workers-types の AnalyticsEngineDataset に構造的にマッチする
// 最小公約数 interface（duck typing で互換）。
export interface AnalyticsDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

export interface AnalyticsBinding {
  writeDataPoint(event?: AnalyticsDataPoint): void;
}

export interface RequestMetricInput {
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  env: string;
  app_version: string;
}

export interface MetricsRecorder {
  recordRequest(input: RequestMetricInput): void;
}

// HTTP ステータスから粗い分類を作る。
//   100-199 → '1xx'
//   200-299 → '2xx'
//   300-399 → '3xx'
//   400-499 → '4xx'
//   500-    → '5xx'
// それ未満（負値や 0）は呼ばれない想定だが、念のため '1xx' に倒す。
export const statusClass = (status: number): string => {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
};

export const createAnalyticsEngineRecorder = (binding: AnalyticsBinding): MetricsRecorder => ({
  recordRequest: ({ method, route, status, duration_ms, env, app_version }) => {
    const klass = statusClass(status);
    binding.writeDataPoint({
      blobs: [method, route, klass, env, app_version],
      doubles: [duration_ms],
      indexes: [klass],
    });
  },
});

export const createNoopMetricsRecorder = (): MetricsRecorder => ({
  recordRequest: () => {
    // intentionally no-op (Node ローカル / テスト / binding 未注入時)
  },
});
