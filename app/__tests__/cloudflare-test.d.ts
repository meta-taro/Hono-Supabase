// @cloudflare/vitest-pool-workers の `cloudflare:test` モジュール型をテスト時のみ有効化する。
// tsconfig.json の types に @cloudflare/vitest-pool-workers を入れると本番ビルドにも漏れるため、
// ここで __tests__ 配下の triple-slash reference として宣言を取り込む（include 対象内なので tsc が拾う）。
/// <reference types="@cloudflare/vitest-pool-workers" />
