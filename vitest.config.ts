import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

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
