import { defineConfig } from 'vitest/config';
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

export default defineConfig({
  test: {
    // テストファイルのパターン
    // - 単体テスト: 実装と共置（例: app/shared/domain/errors.test.ts）
    // - 統合テスト: app/__tests__/integration/ に集約（複数モジュールを跨ぐため）
    include: ['app/**/*.test.ts'],

    // 各テストを独立した環境で実行（グローバル汚染を防ぐ）
    environment: 'node',

    // describe/it/expect をグローバルに使えるようにする（import 省略可）
    globals: true,

    // env の優先順位:
    //   1. .env の値（あれば必ず採用 — infrastructure テストはこのキーで実 Supabase に接続）
    //   2. フォールバックのダミー値（domain / application 単体テスト用。Zod 検証を通すだけ）
    // トップレベルで `export const env = loadEnv()` が走るため、
    // テスト実行時にも required な env を満たす必要がある。
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://localhost:54321',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-service-role-key',
    },

    // カバレッジ設定
    coverage: {
      provider: 'v8',
      include: ['app/**/*.ts'],
      exclude: [
        '**/*.test.ts', // 共置テストを除外
        'app/__tests__/**',
        '**/__test-helpers__/**', // テスト用フィクスチャ（InMemory 実装等）はカバレッジ対象外
        'app/index.ts', // エントリーポイントはカバレッジ対象外
      ],
      thresholds: {
        // 80% 未満はテスト失敗扱い
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },

  resolve: {
    alias: {
      // tsconfig.json の paths と合わせる
      '@': resolve(__dirname, './app'),
    },
  },
});
