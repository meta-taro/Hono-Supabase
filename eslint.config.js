// ESLint v9 フラット設定
// @typescript-eslint/strict で型安全なコードを強制する
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // JavaScript 推奨ルール
  eslint.configs.recommended,

  // TypeScript 厳格ルール（any 禁止・型安全強制）
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json を参照して型情報を取得
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // console.log を警告（logger を使う）
      'no-console': 'warn',

      // 未使用変数はエラー（_ プレフィックスは除外）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Promise の戻り値は必ず await か void で処理する
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // テストファイルはルールを一部緩和
  {
    files: ['app/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // 除外対象
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
);
