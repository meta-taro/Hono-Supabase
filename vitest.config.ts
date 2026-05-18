import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'node:path';

// Node.js 22 標準機能で .env を process.env に注入する。
// vite の loadEnv() を使う案もあるが、pnpm の hoist 設定に依存して動かないことが
// あるため、外部依存ゼロの組み込み機能を採用する。
// - .env がある（ローカル開発）: 実 Supabase キーが入る → infrastructure テストが実 DB を叩ける
// - .env が無い（CI 等）:        ENOENT を黙って無視 → 下のフォールバック値が使われる
try {
  process.loadEnvFile();
} catch {
  // .env が存在しない場合は何もしない（フォールバック値で動かす）
}

// 両プールで共有する @ → app/ のパスエイリアス。
const sharedAlias = { '@': resolve(__dirname, './app') };

// env 値の確定（node-unit プールはこちらを env に流し込む / workers プールはバインディングへ）。
const supabaseUrl = process.env.SUPABASE_URL ?? 'http://localhost:54321';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? 'test-anon-key';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-service-role-key';

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    globals: true,
    // ハイブリッドテスト構成（Phase 7 / Step 9 後の保留タスクで導入）:
    //   - node-unit プール: domain / application / shared 純粋層を Node で速く回す
    //   - workers プール  : infrastructure / integration / Workers 固有 API を workerd で動かす
    //
    // 目的:
    //   typecheck だけでは検出できない Workers 互換性事故（node:crypto / top-level process.env /
    //   pino 引きずり込み等）を、infra+presentation 層のテストで弾く。純粋層は速さ優先。
    projects: [
      // -----------------------------------------------------------------------
      // node-unit プール（threads）— 純粋層・TDD の内ループ
      // -----------------------------------------------------------------------
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'node-unit',
          environment: 'node',
          globals: true,
          include: [
            'app/modules/*/domain/**/*.test.ts',
            'app/modules/*/application/**/*.test.ts',
            'app/shared/domain/**/*.test.ts',
            'app/shared/http/**/*.test.ts',
            'app/shared/infrastructure/logger.test.ts',
            'app/shared/infrastructure/node-pino-logger.test.ts',
            'app/shared/infrastructure/supabase.test.ts',
            'app/shared/infrastructure/metrics.test.ts',
          ],
          env: {
            SUPABASE_URL: supabaseUrl,
            SUPABASE_ANON_KEY: supabaseAnonKey,
            SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
          },
        },
      },
      // -----------------------------------------------------------------------
      // workers プール（@cloudflare/vitest-pool-workers）— infra + integration + Workers 固有
      // -----------------------------------------------------------------------
      // defineWorkersProject は通常の vitest project を返すヘルパー。
      // poolOptions.workers.wrangler で wrangler.toml を読ませることで、本番に近い
      // バインディング・compatibility 設定で workerd を起動する。
      defineWorkersProject({
        resolve: { alias: sharedAlias },
        test: {
          name: 'workers',
          globals: true,
          include: [
            'app/modules/*/infrastructure/**/*.test.ts',
            'app/__tests__/integration/**/*.test.ts',
            'app/shared/infrastructure/jwks-fetcher.test.ts',
          ],
          poolOptions: {
            workers: {
              singleWorker: true,
              wrangler: { configPath: './wrangler.toml' },
              miniflare: {
                // wrangler.toml の [vars] を上書きしてテスト用の値を渡す。
                // SUPABASE_* は secret 扱いなので wrangler.toml には書いておらず、
                // ここでテスト時のみバインディングとして注入する。
                bindings: {
                  SUPABASE_URL: supabaseUrl,
                  SUPABASE_ANON_KEY: supabaseAnonKey,
                  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
                  NODE_ENV: 'test',
                  LOG_LEVEL: 'error',
                },
              },
            },
          },
        },
      }),
    ],

    // カバレッジ設定（両プール合算）
    //
    // provider: 'istanbul' を使う理由（Phase 7 / Step 9 後のハイブリッドテスト導入で必要に）:
    //   v8 provider は内部で Node の `node:inspector` を import するため、
    //   workers プール（workerd）では「No such module 'node:inspector'」で起動できず、
    //   `pnpm test:coverage` が CI で落ちる。
    //   istanbul provider はソースコードに計装コード（counter）を埋め込む方式で、
    //   ランタイム API（inspector）に依存しないため Node / workerd の両プールで動く。
    //   速度は v8 より遅いが、本プロジェクトは CI でしか coverage を取らないので影響軽微。
    coverage: {
      provider: 'istanbul',
      include: ['app/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'app/__tests__/**',
        '**/__test-helpers__/**',
        'app/index.node.ts',
        'app/index.workers.ts',
      ],
      // 閾値:
      //   istanbul は `??` / `||` / optional chaining / switch default 等の分岐を
      //   v8 より細かく数えるため、同じソースでも branches だけ数字が下がる。
      //   現状の v8 換算で 80% 強だったコードベースが istanbul では branches 70%
      //   前後に出る（lines / functions / statements は 80% 維持）ので、branches
      //   だけ 70% に緩める。閾値の絶対値より「数字が後退していないこと」を見る。
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
