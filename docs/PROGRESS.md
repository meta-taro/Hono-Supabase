# Implementation Progress（実装進捗・詳細ログ）

> このファイルは Phase ごとの実装ログ・設計判断の根拠・実機で得た知見の保管庫です。
> CLAUDE.md には現フェーズと完了サマリのみ残し、詳細は本ファイルに退避しています。

---

## Phase 一覧（サマリ）

- [x] **Phase 1**: 設定ファイル群・プロジェクト初期化
- [x] **Phase 2**: Hono アプリ骨格 + `/health` + 統一エラー + 構造化ログ + env 検証
- [x] **Phase 2.5（軌道修正）**: DDD-lite 4 層構造への移行（`app/lib/` → `app/shared/`、`app/modules/{cakes,customers,orders}` 骨格）
- [x] **Phase 3**: `cakes` Bounded Context（domain → application → infrastructure → presentation の縦切り完成）
- [x] **Phase 4**: `customers` Bounded Context（同構造）
- [x] **Phase 5**: `orders` Bounded Context（Domain Event + Postgres Function でアトミック在庫減算）
- [x] **Phase 6**: 認証（Supabase Auth + RLS + 認証ミドルウェア）+ OpenAPI 仕上げ
- [x] **Phase 7**: Cloudflare Workers 化（本番デプロイ想定の最終段）
- [x] **Phase 8（2026-05-14 完了）**: Supabase Auth メール運用（テンプレート / Custom SMTP / 確認後リダイレクト）
- [ ] **Phase 9**: 観測・運用の質を上げる（ロギング・ヘルス・メトリクス・アラート）— **Step 4 のコード実装まで完了（staging 実機の SQL 検証は残）**
- [ ] **Phase 10**: API のリッチ化（ページネーション / ソート / 検索 / 楽観ロック / Rate Limit / Idempotency-Key / Webhook）

---

## Phase 7: Cloudflare Workers 化

- [x] **Step 1**: エントリ二系統化（`app/index.ts` → `app/index.node.ts` リネーム + `app/index.workers.ts` 新設 + 共通組立を `app/bootstrap.ts` に切出）
- [x] **Step 2**: `wrangler.toml` 追加・`@cloudflare/workers-types` 導入・`wrangler` 4.88.0 + `pnpm wrangler:dev` / `wrangler:deploy` / `wrangler:tail` 整備（**`compatibility_flags = []` を維持し `nodejs_compat` に逃げない方針**）
- [x] **Step 3**: 環境変数の移行（ローカル）— `.dev.vars` 導入 + `.dev.vars.example` 配布 + `.gitignore` 追記（`.dev.vars` / `.wrangler/`）
- [x] **Step 4**: ロガー差し替え — pino 依存を `app/shared/infrastructure/node-pino-logger.ts` に隔離。`logger.ts` は `AppLogger` interface + `createWorkersLogger`（`console.log(JSON.stringify(...))` ベース）+ `createSilentLogger` のみ。Workers バンドルから pino を完全除去
- [x] **Step 5**: jose JWKS fetch を `JwksFetcherProvider` で per-request DI 化。Workers 側は `caches.default` + `ctx.waitUntil` で SWR キャッシュ。Node 側は jose 内蔵キャッシュをそのまま使用
- [x] **Step 6**: `wrangler dev` で `GET /health` / `GET /v1/cakes` 200 OK 確認（Hono + Supabase REST が Workers V8 Isolate 上で動作）。33 テスト / 250 テスト全緑、typecheck OK
- [x] **Step 7**: Cloudflare アカウント取得 + Supabase Cloud プロジェクト作成 + `supabase db push`（4 マイグレーション適用）+ `wrangler secret put` ×3（URL / anon / service_role）+ `wrangler deploy` で初回本番デプロイ完了。`https://cake-shop-api.rzrhacympbmdkagoybba.workers.dev/health` / `/v1/cakes` 200 OK 確認（Workers V8 Isolate → Supabase Cloud REST の本番疎通成功）
- [x] **Step 8**: 環境分離。`wrangler.toml` を **`--env <name>` 必須運用**に再構成（`[env.staging]` = `cake-shop-api-staging` / NODE_ENV=staging / LOG_LEVEL=debug、`[env.production]` = `cake-shop-api` / NODE_ENV=production / LOG_LEVEL=info、トップレベル `[vars]` は env 未指定時のフォールバック）。`package.json` の wrangler スクリプトを `:staging` / `:production` 別に分離（素の `wrangler:deploy` / `wrangler:tail` は廃止）。`env.ts` の NODE_ENV enum に `'staging'` を追加。`node-pino-logger.ts` を厳格化（pino-pretty は `NODE_ENV === 'development'` のときだけ適用＝staging/production は両方 JSON 経路）。**staging 用に本番とは別の Supabase プロジェクト `Hono-Supabase-STG`（ref `gnvlfivangrgyryjmybu`）を作成**し、4 マイグレーションを `supabase db push`。**「本番ダンプを staging に流さない」演習として、最初から合成・匿名化済みのテストデータ `supabase/seed.staging.sql` を作成**（`.example` TLD・ダミー顧客 3 + 管理者 1・auth.users 経由で handle_new_user トリガが customers を自動生成・placed_at は日単位に丸めて準識別子を一般化）し `supabase db query --linked -f supabase/seed.staging.sql`（Management API 経由・DB パスワード不要）で投入。`cake-shop-api-staging` Worker に secret 3 種を `wrangler secret put --env staging` で登録 → `wrangler deploy --env staging`。`https://cake-shop-api-staging.<account>.workers.dev/health` `/v1/cakes` 動作確認済み
- [x] **Step 9**: **CI/CD + リリース管理を一周**（実運用のリリースフロー体験）
  - (a) 素の `wrangler deploy` 中に curl ループで無停止切替を観察（**ゼロダウンタイムのベースライン体験**。体験用スクリプト `scripts/zero-downtime-watch.ps1` / `.sh`）
  - (b) `wrangler versions upload` でバージョン作成（**流量 0**）→ 払い出された preview URL で動作確認
  - (c) `wrangler versions deploy --percentage 10` でカナリア展開 → 50% → 100% の段階展開を curl ループで観察
  - (d) わざとバグを入れて 100% リリース → `wrangler rollback` で**直前バージョンへ即時巻き戻し**
  - (e) GitHub Actions 化（`cloudflare/wrangler-action@v3`）— ワークフローを**ブランチ別に分割**: `deploy-staging.yml`（`push: develop` → `checks` → `wrangler deploy --env staging`。本番には一切触れない）／`deploy-production.yml`（`push: main` → `checks` → `wrangler versions upload --env production`(0%) → Environment `production` の Required reviewers 承認ゲート → `wrangler versions deploy <id>@100 --env production --yes`）。`checks.yml`（再利用 `workflow_call` = Lint&Typecheck / Bundle check (tsup + wrangler dry-run) / Test (Vitest + local Supabase)）を `ci.yml`（PR）と両 deploy が呼ぶ。`main` ブランチ保護（PR 必須・status checks 3 本必須・force push/削除禁止・bypass なし）+ リポジトリ Secrets（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。Supabase 鍵は置かない＝Worker の `wrangler secret` 側）+ Environments（`staging` ゲートなし / `production` Required reviewers）も設定済。**運用ポリシーの全文は README「## CI/CD・環境構成の指針（実運用想定）」を参照**

### CI/CD・リリース運用の要点（詳細は README）

- **ブランチ→環境**: `develop` push = staging に自動デプロイ（即時 100%）／`main` push = production（`versions upload` 0% → **GitHub Environment `production` の手動承認** → `deploy@100`）。feature → PR → CI → `develop` マージ → 区切りで `develop`→`main` PR → マージで本番。ロールバックは `wrangler rollback --env production`
- **`main` はブランチ保護必須**: PR 経由のみ・CI チェック必須・force push/削除禁止。本番に出すコードは必ず CI を通った `main` の内容
- **シークレットの置き場を分ける**: アプリのシークレット（`SUPABASE_*`）は実行環境（`wrangler secret put --env <name>`）／CI のシークレット（`CLOUDFLARE_API_TOKEN` 等）は GitHub リポジトリ Secrets。リポジトリにも他方にも混ぜない
- **Supabase は 1 環境 1 プロジェクト**: production / staging で別プロジェクト。**本番データを staging に流さない**（合成・匿名化シード `supabase/seed.staging.sql` を使う）。マイグレは前方向のみ・`supabase db push`、アドホック SQL は `supabase db query --linked -f`
- **ドキュメント上の識別子の線引き**: 個人固有の値（Cloudflare アカウントサブドメイン・Supabase project ref）は `<...>` プレースホルダ表記。構成上の固有名（Worker 名 `cake-shop-api` / プロジェクト名 `Hono-Supabase` / env 名）はそのまま残す（フォーク者が「これ何？」にならないように）

---

## Phase 8: Supabase Auth メール運用（2026-05-14 完了）

**動機**: 「Supabase Auth を使うバックエンド担当」が「確認メールのテンプレートを更新できる・Custom SMTP に切替えられる」を一度も触らないのは学習漏れ。本番が `enable_confirmations = ON`（＝正しい設定）である以上、その運用面を一周しておく

- [x] **Step 1（2026-05-13 完了）**: ローカルで `supabase/config.toml` の `[auth.email] enable_confirmations = true` に変更（＝本番 Cloud に合わせた）。`POST /v1/customers` → Mailpit/Inbucket（http://localhost:54324）に確認メール受信 → 確認リンク（`/auth/v1/verify?token=...&type=signup&redirect_to=<site_url>`）を踏むと 303 + `auth.users.email_confirmed_at` がセット／確認前ログインは 400 `email_not_confirmed`／確認後ログインで JWT 取得、を実機確認。**この変更で顕在化したバグも修正**: `enable_confirmations = ON` だと `auth.signUp()` がセッションを返さない → サインアップ経路の sb は anon のまま → 直後の「トリガが作った `customers` 行を `authUserId` で読み戻す」が RLS で弾かれ 404 になっていた（本番も同じ潜在バグ）。`composition-root.ts` でサインアップ用に `CustomerSupabaseRepository(createAdminClient(env))` を 1 本足し、サインアップ経路の `customers` 参照のみ RLS バイパスの service_role 経由に（`auth.signUp()` 自体は公開 auth 操作なので anon のまま）。副次効果として `findByEmail` の重複チェックが実際に効くようになり、同一メール再登録が 409 `CONFLICT` を返すようになった
- [x] **Step 2（2026-05-14 完了）**: メールテンプレートを **リポジトリ管理**化。`supabase/templates/{confirmation,recovery,magic_link,email_change}.html` を新設（日本語＋ブランド色 `#b85c5c`・テーブルレイアウト + インライン CSS で HTML メール互換）。`supabase/config.toml` の `[auth.email.template.*]` 4 セクションを有効化、件名を `【ケーキショップ】…` に日本語化。Go template 変数（`{{ .ConfirmationURL }}` / `{{ .Token }}` / `{{ .SiteURL }}` / `{{ .Email }}` / `{{ .NewEmail }}` / `{{ .Data }}`）の使い方を冒頭コメントに整理。confirmation メールは Mailpit で実機表示を確認済（recovery / magic_link / email_change は同じ仕組みなので個別検証は省略）。`.prettierignore` に `supabase/templates/` を追加（HTML メールの属性改行を prettier に壊させないため）
- [x] **Step 3（2026-05-14 完了）**: 確認後リダイレクトの三層設計（`site_url` / `additional_redirect_urls` / `redirect_to`）と PKCE/Implicit フローを整理し、README に新節「## 認証メールのリダイレクト設計（Supabase Auth・Phase 8 Step 3）」を追加。`additional_redirect_urls` に将来のフロント用 `http://127.0.0.1:3000/auth/callback` を許可リストとして追加（着地先の切替コスト最小化）。フロント不在での実機観察手順（Mailpit からリンク → `?code=...` でブラウザのアドレスバーに着地 → PKCE 動作確認）と、フロント有り時の Next.js App Router `app/auth/callback/route.ts` の理屈（`exchangeCodeForSession` + `type` 分岐 + cookie 保存）も README に明記
- [x] **Step 4（2026-05-14 完了 — 方針変更）**: 当初は「ローカルで `[auth.email.smtp]` を Resend に切替えて実メール送信を体験」と定義していたが、実行段階で **ホスト Windows の Norton Antivirus "Web/Mail Shield" が outbound TLS を巻き取り、自社 CA で再署名する** ため、gotrue コンテナ → smtp.resend.com の TLS 検証が `x509: certificate signed by unknown authority` で必ず失敗することが判明（PowerShell の生 TLS で確認した Issuer が `CN=Norton Web/Mail Shield Root` だった）。Norton Root を コンテナの CA 束に注入する案は学習リポジトリの clean さを壊し、Norton の TLS スキャンを切る案は PC のセキュリティ運用を犠牲にするため不採用。**Step 5 と統合して「Cloud 上の Supabase に直接 Resend を繋ぐ」に再定義**することで、Custom SMTP の学習目的（設定経験・送信元検証・ブランド差出人）は完全達成可能と判断。リポジトリには「ローカルで実 SMTP 検証は TLS インスペクション環境では成立しない」旨を `supabase/config.toml` のコメントブロック / `.env.example` / README に記録（同じ罠を踏まないため）。ローカルは引き続き Inbucket（http://127.0.0.1:54324）で運用
- [x] **Step 5（2026-05-14 完了）**: **Cloud 上の Supabase（production / staging）に Custom SMTP を直接設定して実メール送信** — Resend を無料枠 + ドメイン未認証で運用（自前ドメイン未取得のため `onboarding@resend.dev` を Sender、Sender Name `ケーキショップ` でブランド感だけ確保）。Supabase Dashboard → Authentication → Emails の **SMTP Settings**（Host=`smtp.resend.com` / Port=587 / Username=`resend` / Password=Resend API key、staging / production で別 API key）と **Templates**（Confirm sign up / Reset password / Magic link / Change email address の Subject + Body を `supabase/templates/*.html` の中身で上書き）を staging → production の順で設定。staging で `POST /v1/customers` → Gmail に「ケーキショップ \<onboarding@resend.dev\>」差出人・日本語テンプレで確認メール到達（DKIM `resend.dev` 署名で Gmail スパムフィルタ通過）→ 確認リンク踏破 → URL ハッシュに JWT（`email_verified: true`）が乗って戻ってくる、まで end-to-end 確認。**production への Phase 8 Step 1 admin client 修正の本番反映を Phase 7 Step 9 の本番リリースパイプライン（`develop`→`main` PR → CI 緑 → `versions upload --env production`（0%）→ Environment `production` 承認ゲート → `versions deploy <id>@100`）で実施** — 本番 `POST /v1/customers` で 409 CONFLICT（メール重複）が返ることを確認＝ admin クライアント経由の `findByEmail` が本番で正しく動作する証拠。**罠**: Resend 無料枠の宛先制限は SMTP の `RCPT TO` 生文字列を見るため、Gmail の `+alias` トリック（例 `online384+prod@gmail.com`）は別宛先として弾かれる（`Error sending confirmation email`）。完全一致で叩く or 自前ドメインを Resend で認証する

---

## Phase 9: 観測・運用の質を上げる（進行中）

**動機**: Phase 7 で Workers 互換ロガー（pino 互換 JSON 出力）の土台は整ったが、「障害が起きた時に 1 リクエストで吐かれた全ログを追える」「依存サービスの異常を `/health` で検知できる」「エラー率が急騰したらアラートが飛ぶ」までは未整備。**本番に出した API を運用できる状態**にするための観測ハードを一周する

- [x] **Step 1（2026-05-15 完了）**: リクエスト ID 伝播 + リクエストスコープロガー — `app/shared/http/request-context.middleware.ts` を新設し、入口で `X-Request-Id` ヘッダを採用（サニタイズ `/^[A-Za-z0-9_-]{1,128}$/` を通らない値はログ汚染対策として拒否）→ 無ければ `crypto.randomUUID()`（Web Crypto API、Workers / Node 22 双方に組み込み）で生成。`AppVariables` に `requestId?` / `logger?` を追加し、`c.set('logger', baseLogger.child({ requestId, method, path }))` で req スコープロガーを積む。`createApp` に `globalMiddlewares` フィールドを足して `*`（`/health` 含む全パス）に適用 — 外形監視からの叩きも追跡可能。レスポンスヘッダ `X-Request-Id` に反射（クライアントが障害報告時に貼ってもらう運用）。`error-handler` を `c.get('logger') ?? fallbackLogger` 優先に切替（child binding に requestId / method / path が乗るので重複出力を削除）。`createModulesMiddleware` も `c.get('logger') ?? deps.logger` を採用し、per-request UseCase / Repository が req スコープロガーを引くように。テストは middleware の単体（7 ケース: 有効ヘッダ採用 / 未指定で自前生成 / 空白拒否 / 不許可文字拒否 / 128 文字超拒否 / child bindings 検証 / デフォルト UUID v4 形式）+ `pnpm verify` 緑（267 テスト）+ `pnpm test:coverage` 緑（middleware 100% カバー）
- [x] **Step 2（2026-05-15 完了）**: アクセスログミドルウェア — `app/shared/http/access-log.middleware.ts` を新設。入口で `start = Date.now()`、出口で `{status, duration_ms, userId}` を req スコープロガー経由で出力（`method` / `path` / `requestId` は Step 1 の child binding に既に乗っているため二重出力しない）。ステータス別レベル出し分け（5xx → `error` / 4xx → `warn` / 他 → `info`）。`userId` は `c.get('user')?.id` を spread で未認証時にキーごと省略（`userId: undefined` を残さない）。`bootstrap.ts` で `requestContextMiddleware` の直後に並べて `/health` 含む全パスに適用。Hono 標準 `logger()` を使わない理由 = console.log プレーンテキストで structured 検索不可 + req スコープロガーの requestId バインドを引き継げない。`logger` 未挿入経路では no-op（fallback logger 入れると Workers バンドルに pino / 裸 console を混ぜるリスク）。テスト 6 ケース（2xx info / 4xx warn / 5xx error / 認証済 userId 出力 / 未認証 userId 省略 / logger 未挿入時 no-op）+ `pnpm verify` 緑（273 テスト）+ `pnpm test:coverage` 緑（middleware 100% カバー）
- [x] **Step 3a（2026-05-18 完了）**: `/health` の充実（骨格 + 仮の閾値） — `app.ts` の `AppOptions` に `healthDbProbe?: HealthDbProbe`（`() => Promise<{ok, latency_ms}>`）を追加。bootstrap で anon Supabase クライアントを 1 度だけ生成し、`cakes` を `select('id').limit(1).abortSignal(AbortSignal.timeout(1500))` で叩く実 probe を注入。失敗パス（タイムアウト・HTTP エラー・接続不到達）は全て catch して `{ok:false, latency_ms:<経過時間>}` に丸める。/health は 3 状態を返す: `probe.ok && latency_ms ≤ 800` → `ok` / `probe.ok && latency_ms > 800` → `degraded` / それ以外 → `down`。HTTP は `ok|degraded` → 200・`down` → 503（外形監視を pager に乗せるため degraded では緑、down のみ赤）。仮の閾値: probe timeout 1500ms / degraded boundary 800ms / stateless（連続失敗カウントなし）。probe 省略時は従来通り `{status:'ok', version}` のみ（最小 health.test.ts 互換）。テスト 6 ケース（既存 2 + 新規 4: ok / degraded / down(タイムアウト相当) / down(クエリエラー相当)）+ `pnpm verify` 緑（277 テスト）。詳細は README「`/health` の応答仕様（Phase 9 Step 3a）」節
- [x] **Step 3b（2026-05-18 完了）**: `/health` 閾値の実測すり合わせ — Step 3a で仮置きした 3 つの設計判断（`DEGRADED_LATENCY_MS=800` / `PROBE_TIMEOUT_MS=1500` / stateless）を、コードを一時改変 → revert する方式で 3 シナリオ実測検証し、**全て据え置きで妥当**と結論。観測結果:
  - **ベースライン**: ローカル Supabase へ `latency_ms ≈ 290ms`（初回 cold）→ `36–66ms`（暖機後）。安定して degraded(800ms) を大きく下回る → 800ms の幅は妥当
  - **シナリオ 1（degraded 観察）**: `DEGRADED_LATENCY_MS=5` に一時変更 → 36ms 応答が `status:"degraded"` / HTTP 200 に切替。3 状態の分岐と「degraded は緑（200）のまま」の運用方針を実機確認
  - **シナリオ 2（down: タイムアウト経路）**: `PROBE_TIMEOUT_MS=50` に一時変更 → REST 応答が AbortSignal で打ち切られ `status:"down"` / HTTP 503 / `latency_ms=59ms`。タイムアウト→down→503 の経路がドキュメント通り動く
  - **シナリオ 3（down: 接続不到達経路）**: `supabase stop` で REST 側を完全に落としてから curl → `status:"down"` / HTTP 503 / `latency_ms=1518ms`（= ほぼ `PROBE_TIMEOUT_MS=1500`）。**最大の学び**: Docker Desktop / WSL2 経由のポートはコンテナ停止直後でも TCP SYN を即座に RST せず吸い込んでしまうため、TCP 層で「接続不到達」は観測されず**全部タイムアウト経由で down に倒れる**。逆に言えば `AbortSignal.timeout()` を入れていなければ /health は OS のデフォルト fetch タイムアウト（30–120 秒）まで握り続け、外形監視が真っ赤になる前にユーザが先に気付く事故になりうる。**probe timeout の存在価値が実機で証明**された
  - **結論**: 3 閾値とも本番投入に十分。連続失敗集計の追加は Step 5（アラート）と一緒に設計する方が筋がよい（/health 単体に状態を持たせると Worker isolate 跨ぎで一貫性が出ず、結局 Analytics Engine / Logpush 側で時系列集計する方が素直）ため Step 3b 範囲では見送り。詳細は README「`/health` の応答仕様」節「Step 3b 実測体験のまとめ」
- [~] **Step 4（2026-05-18 — コード実装完了 / staging 実機の SQL 検証は残）**: メトリクス収集（Workers Analytics Engine） — commit `f939de1` で実装一式が乗った。Cloudflare Dashboard での SQL 検証（p95 latency / 5xx 率）はこの後 staging に試走させて行う。
  - **何を作ったか**:
    - `app/shared/infrastructure/metrics.ts` を新設。`MetricsRecorder` interface + `RequestMetricInput`（method / route / status / duration_ms / env / app_version）+ ファクトリ 2 種（`createAnalyticsEngineRecorder` = 実書き込み、`createNoopMetricsRecorder` = Node ローカル / テスト / binding 未注入用）。`writeDataPoint` に渡すペイロードは固定順 = **blob `[method, route, status_class, env, app_version]` / doubles `[duration_ms]` / indexes `[status_class]`**。`statusClass(status)` で HTTP ステータスを `'1xx'..'5xx'` に粗く分類（SQL の `WHERE index1='5xx'` 直撃用、`status` 生値は blob に別途残す）
    - `app/shared/http/access-log.middleware.ts` に `metrics?: AccessLogMetricsBinding` 注入オプションを追加。注入時はアクセスログ出力直後に `recorder.recordRequest({ method, route, status, duration_ms, env, app_version })` を呼ぶだけ。`writeDataPoint` は fire-and-forget なのでレスポンス遅延に乗らない
    - `wrangler.toml` の **`[env.staging]` / `[env.production]` の両方に `[[…analytics_engine_datasets]]`** を追加。dataset は **A 案: 物理分離**（`api_requests_staging` / `api_requests_production`）を採用、binding 名 `API_REQUESTS` は共通でアプリコード側を env 非依存に保つ。トップレベルにも fallback dataset を 1 個書いておく（`--env` 付け忘れ時の保険、Phase 7 Step 8a の運用方針と整合）
    - `app/bootstrap.ts` に `metricsRecorder?: MetricsRecorder` を BootstrapDeps に追加し、注入されていれば `AccessLogMetricsBinding = { recorder, env: env.NODE_ENV, app_version: appVersion ?? 'local' }` を組んで `createAccessLogMiddleware({ metrics })` に渡す
    - `app/index.workers.ts` で `bindings.API_REQUESTS` が来ていれば `createAnalyticsEngineRecorder`、無ければ `createNoopMetricsRecorder()` を採用（`wrangler dev` で binding 未バインドのまま動かしてもクラッシュしない）。`index.node.ts` は metricsRecorder を渡さず未注入経路に落とす
  - **設計判断と理由**:
    - **`@cloudflare/workers-types` への直接依存を避ける**: `AnalyticsBinding` / `AnalyticsDataPoint` を `metrics.ts` 内に自前 interface で定義（duck typing）。Phase 7 でロガーを Workers / Node 両対応にした時と同じ DI 隔離方針 — `shared/infrastructure/` から `@cloudflare/workers-types` を引っ張ると Node 経路で型衝突が起きやすい
    - **`hono/route` の `routePath(c, -1)` を使う**: middleware 経由（`app.use('*', ...)`）で素の `routePath(c)` を呼ぶとミドルウェア自身の `'*'` が返ってしまう。`-1` を渡すと末尾＝最も内側のハンドラのルートを取れる（例 `/v1/orders/:id`）。**生 path だと UUID / 注文 ID 分カーディナリティが爆発**して dataset の上限（Analytics Engine は high-cardinality に弱い）を一気に食い潰す。未マッチ経路（404）では空文字 / undefined になりうるので `'/unknown'` に倒す
    - **PII は 1 つも入れない**: `userId` はアクセスログ（structured logs）には載せるが、メトリクス（Analytics Engine）には載せない。一覧性のあるテーブル系ストアに userId を入れると統計集計時の誤プロファイリングや 90 日リテンション中の GDPR 相当の話が絡む。アクセスログは「個別障害調査」用、メトリクスは「集計」用と用途を分離
    - **物理分離（A 案）採用**: staging と production の dataset を分けると **SQL の WHERE 句で env 混入事故を構造的に防げる**（同じ dataset に `blob4='staging'` で混ぜる B 案より安全）。Analytics Engine は 10M events/month の無料枠 + 90 日保持なので学習リポジトリでも余裕で 2 本持てる
    - **5xx でもメトリクスは出す**: アクセスログでは error レベルになるが、メトリクスは「5xx の発生数 / 率」を後から集計するのが目的なので **status はそのまま渡して dataset に書く**。SQL 側で `WHERE index1='5xx'` でフィルタする想定
  - **テスト**:
    - `app/shared/infrastructure/metrics.test.ts`（新設、19 ケース）— `statusClass` の境界（199/200/299/300/399/400/499/500/負値）+ `createAnalyticsEngineRecorder` の blob 順検証（5xx/4xx で `blobs[2]` / `indexes[0]` が `'5xx'`/`'4xx'`）+ `doubles[0] = duration_ms` + noop が例外を投げない
    - `app/shared/http/access-log.middleware.test.ts`（既存 6 ケースに 4 ケース追加）— metrics 注入時の `recordRequest` payload 検証 / 動的セグメント `/v1/orders/:id` が正規化形で渡る / 5xx でも記録される / 未注入時は `recordRequest` を呼ばない
    - `vitest.config.ts` の `node-unit` プール include に `metrics.test.ts` を追加（純粋ユニットなので Node プールで速く回す）
    - `pnpm verify` 緑（37 ファイル / 300 テスト、Node プール + workers プール両方）
  - **残タスク**: staging に push 済の deploy パイプライン経由でデプロイ → 20–30 curl で 2xx/4xx/5xx を混ぜて投げる → Cloudflare Dashboard → Workers & Pages → Analytics → Analytics Engine の SQL コンソールで以下 2 本を確認:
    - **p95 latency**: `SELECT quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms FROM api_requests_staging WHERE timestamp > now() - INTERVAL '1' HOUR`
    - **5xx 率**: `SELECT countIf(index1 = '5xx') / count() AS error_rate FROM api_requests_staging WHERE timestamp > now() - INTERVAL '1' HOUR`
  - **fire-and-forget の含意**: `writeDataPoint` の戻り値を await しない → レスポンス遅延ゼロ。ただし書き込み失敗は呼び出し側で観測不能（Analytics Engine の障害時は静かに欠測になる）。「観測の観測」までは無料枠でやりすぎなので Step 5（Logpush / アラート）と合わせて検討
- [ ] **Step 5**: Logpush / アラート — Cloudflare Logs を R2 / 外部 SaaS（Logpush）に送る設定 + Notifications でメール / Slack 連携。「わざと 5xx を出してアラートが飛ぶ」演習で end-to-end 確認

---

## Phase 10: API のリッチ化（未着手）

**動機**: 現状の cakes/customers/orders は MVP 規模。実運用 API なら必須レベルの「ページネーション / ソート / 検索 / 楽観ロック / Rate Limit / Idempotency-Key / Webhook」を**設計判断の練習場**として一周する。それぞれ単独の機能というより「設計上のトレードオフを言語化する素材」として扱う

- [ ] **Step 1**: ページネーション — cursor-based（`?after=<id>&limit=20`）を採用。理由は「offset/limit は LIMIT が大きい時に slow query になり、新規 INSERT で zip がズレる」「学習プロジェクトで両方は冗長」。`/v1/cakes` `/v1/orders` に導入。`Link` ヘッダ（RFC 5988）/ レスポンスボディ `next_cursor` 両論併記でユーザーに選んでもらう
- [ ] **Step 2**: ソート・フィルタ — `?sort=-created_at,name` のような RFC 想定書式と Zod 検証。`/v1/cakes?available=true` のような単純フィルタ
- [ ] **Step 3**: 検索 — Postgres `pg_trgm` か `tsvector` で部分一致 / 全文検索を実装（学習として両方の使い分けを言語化）
- [ ] **Step 4**: 楽観ロック — `ETag` + `If-Match` で更新時の競合検知。Cake の在庫更新（追加発注）に導入。`409 CONFLICT` を出す
- [ ] **Step 5**: Rate Limit — Cloudflare Workers の Rate Limiting API（無料枠）or Hono の `rateLimiter` ミドルウェア。IP / userId 別の制限。429 + `Retry-After` ヘッダ
- [ ] **Step 6**: Idempotency-Key — `POST /v1/orders` で重複作成を防ぐ。`Idempotency-Key` ヘッダを受け取り、初回成功レスポンスを KV / DB にキャッシュ → 同キー再送で同レスポンスを返す（Stripe API スタイル）
- [ ] **Step 7**: Webhook 配信 — 「注文確定」のドメインイベントを外部 URL に POST する仕組み。HMAC 署名 + retry-with-backoff + DLQ 設計
