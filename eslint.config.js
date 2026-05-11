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

  // テストコードはルールを一部緩和
  //   対象: 共置テスト（*.test.ts）/ 統合テスト（__tests__/）/ テスト用フィクスチャ（__test-helpers__/）
  //   - no-unsafe-assignment / no-explicit-any: モック・フィクスチャで any を扱うため
  //   - no-non-null-assertion: フィクスチャを自分で組み立てるテストでは arr.find(...)! が自然
  //   - require-await: fake 実装（in-memory repo / fake Cache 等）は await を持たない async が普通
  //   - no-unnecessary-type-assertion: app.request(path).json() は Promise<unknown> 型なので
  //       `(await res.json()) as ResponseShape` でレスポンス本体に型を付けるのが定石。
  //       このルールは「型を変えていない」と誤検知するが、外すと typecheck が unknown で落ちる
  //   - no-unnecessary-condition: Supabase SDK の戻り値型は楽観的（data 非 null 等）だが、
  //       seed/cleanup ヘルパでは「型上は不要だが実行時に効く」防御ガード（error || !data.user 等）を残す
  {
    files: ['app/**/*.test.ts', 'app/**/__test-helpers__/**/*.ts', 'app/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // 除外対象
  //   - dist / coverage / node_modules: ビルド成果物・依存
  //   - .wrangler: wrangler dev / build が吐く一時バンドル（TS project 外なのでパースエラーになる）
  //   - *.config.{js,ts}: ルート設定ファイルは tsconfig の include 外（型情報付き lint の対象にしない）
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.wrangler/**',
      'eslint.config.js',
      'vitest.config.ts',
    ],
  },
);
