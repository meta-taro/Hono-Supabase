import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // テストファイルのパターン
    include: ['app/__tests__/**/*.test.ts'],

    // 各テストを独立した環境で実行（グローバル汚染を防ぐ）
    environment: 'node',

    // describe/it/expect をグローバルに使えるようにする（import 省略可）
    globals: true,

    // カバレッジ設定
    coverage: {
      provider: 'v8',
      include: ['app/**/*.ts'],
      exclude: [
        'app/__tests__/**',
        'app/index.ts', // エントリーポイントはカバレッジ対象外
        'app/types/**',
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
