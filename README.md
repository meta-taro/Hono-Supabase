# Cake Shop Order API

Hono × Supabase × TypeScript で構築する、実務志向の軽量 REST API サンプル。

[![Node.js](https://img.shields.io/badge/Node.js-22_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-Latest-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 学習用サンプルですが、**実運用で困らないレベル** を意識して設計しています。
> **DDD-lite（モジュラモノリス × 4 層構造）** を採用し、API バージョニング、構造化ログ、Zod による型安全な入出力、Supabase Auth + RLS、OpenAPI 自動生成、TDD まで一通り実装します。
>
> ⚠️ **ローカル開発が「Node（`pnpm dev`）」と「Workers ランタイム（`pnpm wrangler:dev`）」の二段構えになっているのは意図的な学習設計です。** 本番最小の Workers バックエンドが欲しい場合はもっと薄くできます — 理由と「畳み方」は [設計上のトレードオフと本番最小構成への畳み方](#設計上のトレードオフと本番最小構成への畳み方) を参照してください。

---

## ドメイン

ケーキ屋を題材にした注文管理 API。

- ケーキの一覧・登録（管理者のみ登録可）
- 顧客のサインアップ・一覧
- 注文の作成・参照（本人のみ）

---

## 想定する利用シーン

本リポジトリは **バックエンド API 単体** ですが、以下のような構成での利用を想定して設計しています。

### 典型構成: Next.js フロント × Hono API × Supabase

```
[ブラウザ]
    ↓
[Next.js (Vercel 等)]    ← UI / SSR / Server Components
    ↓ fetch + Bearer JWT
[Hono API (本リポジトリ)]
    ↓
[Supabase]               ← Auth (JWT 発行) / DB / RLS
```

- **認証は Supabase Auth が発行する JWT** を `Authorization: Bearer <token>` ヘッダで受け取る方式（ステートレス）。Next.js 側で `@supabase/supabase-js` を使って取得した JWT をそのまま本 API に渡せる
- **本番デプロイ先は Cloudflare Workers**（V8 Isolate 上のグローバルエッジ実行）。Hono が Web 標準 API ベースで Workers ネイティブに動くため、`@hono/node-server` を使わずに `export default app` 形式で展開する
- **ローカル開発・自動テストは Node.js 22**（tsx watch + Vitest）で快適に進め、本番経路だけ Workers に切り替える二段構え。同一の `app.ts` がランタイム非依存で動作（Vercel Edge / Bun / Deno への展開も理論上可能）
- **クロスドメイン構成 OK**（CORS 対応は Phase 6 で導入予定）

### 単体動作も可能

Next.js が無くても、本 API 単体で以下のように利用可能:

- `curl` / `Bruno` / `Postman` で直接叩く（学習・QA・E2E 用途）
- 別フレームワーク（Nuxt / SvelteKit / モバイルアプリ等）から利用
- バッチジョブ・CLI ツールから利用

つまり **「フロントエンド技術非依存の汎用 API」** として設計しています。

### スコープ外（本リポジトリには含まないもの）

- フロントエンド実装（Next.js / React 等）
- 専用 SDK / 型安全クライアント（Hono の `hc<typeof app>` を使えば Next.js 側で型推論可能だが、本リポはサーバー側に専念）
- インフラ構築コード（IaC・CI/CD は別途）

---

## 主な特徴

- **DDD-lite アーキテクチャ**: Bounded Context（`cakes` / `customers` / `orders`）× 4 層（`domain` / `application` / `infrastructure` / `presentation`）。依存方向を内向き一方向に固定し、ドメイン層を DB 非依存に保つ
- **Repository + UseCase パターン**: domain で interface を定義、infrastructure で Supabase 実装。UseCase は in-memory repo で爆速テスト
- **API バージョニング**: 全業務エンドポイントを `/v1` 配下に配置（`/health` のみ非バージョン）
- **型安全な API 設計**: `@hono/zod-openapi` で Zod スキーマから OpenAPI 仕様を自動生成（仕様の二重管理ゼロ）
- **構造化ログ（ランタイム適応）**: 本番（Cloudflare Workers）は `console.log(JSON.stringify(...))` ベースの軽量ロガー（pino 互換出力）、ローカル開発（Node）は pino + pino-pretty で整形表示。`AppLogger` interface を共通化し、呼び出し側コードはランタイムに気付かない
- **統一エラーレスポンス**: `code` / `message` / `details` 形式で、クライアントがプログラム的にエラー種別を分岐可能
- **fail-fast な env 検証**: 起動時に Zod で `process.env` を検証
- **Supabase Auth + RLS**: JWT 認証ミドルウェア + Row Level Security でテーブル単位のアクセス制御
- **TDD 必須**: Vitest によるカバレッジ 80% 強制（未達はビルドエラー）。テストは実装と共置
- **再現性ある開発環境**: fnm で Node 固定、corepack で pnpm 固定、Supabase CLI でローカル DB 完結

---

## 技術スタック

| カテゴリ                | 採用                                                                                     | 選定理由                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **本番ランタイム**      | **[Cloudflare Workers](https://workers.cloudflare.com/)**（V8 Isolate）                  | グローバルエッジ・ゼロダウンタイムデプロイ・$0〜$5/月クラスの低コスト                                                                                              |
| **本番ビルド/デプロイ** | **[Wrangler](https://developers.cloudflare.com/workers/wrangler/)**                      | `wrangler deploy` 1 コマンドで本番反映                                                                                                                             |
| ローカル開発ランタイム  | Node.js 22 LTS                                                                           | TDD・デバッグ・型チェックを Node 上で完結。tsx watch でホットリロード                                                                                              |
| Framework               | [Hono](https://hono.dev/) 4.x                                                            | 軽量・高速・型安全。**同一コードで Workers / Node / Vercel Edge / Bun / Deno** に展開可能                                                                          |
| OpenAPI                 | [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) | コードと仕様の二重管理を回避                                                                                                                                       |
| Validation              | [Zod](https://zod.dev/)                                                                  | TypeScript ネイティブのスキーマ検証                                                                                                                                |
| Database                | Supabase (PostgreSQL 15)                                                                 | Auth / RLS / Realtime まで含む BaaS。Workers から **REST 経由**で接続可能                                                                                          |
| Logger                  | Workers 互換実装（本番）/ [pino](https://getpino.io/) + pino-pretty（ローカル開発）      | 本番（Workers）は `console.log(JSON.stringify(...))` ベースの軽量実装。ローカル開発時のみ pino を `devDependencies` として併用し、整形ログで TDD・デバッグを快適に |
| Test                    | [Vitest](https://vitest.dev/)                                                            | Vite ベース、ESM ネイティブ、高速                                                                                                                                  |
| Package Manager         | pnpm 9.15.0 (via corepack)                                                               | ディスク効率・モノレポ対応・速度                                                                                                                                   |
| Container               | Docker Compose（アプリのみ・ローカル学習用途）+ Supabase CLI（DB）                       | 本番は Workers なのでコンテナ不要                                                                                                                                  |

### 依存パッケージの方針（`dependencies` vs `devDependencies`）

本プロジェクトは **本番 = Cloudflare Workers / ローカル開発・テスト = Node.js** の二段構えで動かすため、**本番（Workers バンドル）に乗らない Node 専用パッケージは `devDependencies` に分離**しています。

| パッケージ                                                              | 配置              | 理由                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hono` / `zod` / `@supabase/supabase-js` / `jose` / `@hono/zod-openapi` | `dependencies`    | Workers / Node 双方で利用                                                                                                                                                                                                                  |
| `pino` / `pino-pretty`                                                  | `devDependencies` | **Node ローカル開発時の整形ログ専用**。`worker_threads` / `fs` 依存があり Workers では動かないため、`app/shared/infrastructure/node-pino-logger.ts` に物理隔離して `app/index.node.ts` からのみ import。Workers バンドルには一切混入しない |
| `@hono/node-server`                                                     | `devDependencies` | Node ランタイムで HTTP サーバを起動するためのアダプタ。Workers では `export default app` 形式で動くため不要                                                                                                                                |
| `wrangler` / `@cloudflare/workers-types` / `tsx` / `tsup` / `vitest` 等 | `devDependencies` | ビルド・テスト・型ツール                                                                                                                                                                                                                   |

> **「`node-pino-logger.ts` で `import pino` しているのに `dependencies` にない」のは意図通り**です。Workers ランタイムへの混入を物理的に防ぐため、Node 側のエントリだけが pino を読みます。本番デプロイ（`wrangler deploy`）は Workers バンドルしか作らないので pino を解決する必要がありません。

---

## 設計上のトレードオフと本番最小構成への畳み方

> なぜローカル開発が「Node（`pnpm dev`）⇄ Workers ランタイム（`pnpm wrangler:dev`）」の二段構えなのか、その代償、そして「Workers 専業ならこう畳める」を説明します。

このリポジトリは **ローカル開発を 2 系統** 持っています:

| コマンド            | エントリ               | ランタイム                         | ロガー                                    | 用途                                |
| ------------------- | ---------------------- | ---------------------------------- | ----------------------------------------- | ----------------------------------- |
| `pnpm dev`          | `app/index.node.ts`    | Node.js（tsx watch）               | pino + pino-pretty                        | 普段の TDD・デバッグ                |
| `pnpm wrangler:dev` | `app/index.workers.ts` | `workerd`（本番と同じ V8 Isolate） | `createWorkersLogger`（console.log JSON） | デプロイ前の Workers 互換性チェック |
| `pnpm test`         | （Vitest）             | Node.js                            | silent                                    | 自動テスト                          |

そのため `app/index.node.ts` / `app/index.workers.ts` の 2 エントリ、両者で組立を共有する `app/bootstrap.ts`、pino を Node 側に隔離する `app/shared/infrastructure/node-pino-logger.ts`、`devDependencies` の `@hono/node-server` / `pino` / `pino-pretty` / `tsx` / `Dockerfile` / `docker-compose.yml` ── と、**「Workers 専業」なら不要なものが意図的に乗っています**。「無駄に肥大化している」のではなく「学習目的で厚くしている」ものです。判断材料を以下に置きます。

### 二段構えが買っているもの

- **TDD の内ループの速さ**: `tsx watch` + Node デバッガ（ブレークポイント・即時再起動）は、`wrangler dev` より起動が軽く回しやすい。本プロジェクトは TDD 必須なのでここを重視
- **ログの可読性**: 高速イテレーション中は pino-pretty の色付き整形ログが、`{"level":30,"time":...}` の生 JSON より読みやすい
- **ランタイム抽象化パターンの練習**: 「`app.ts` 以下はランタイム非依存に保ち、ランタイム固有部分（ロガー実装・HTTP サーバ起動・JWKS フェッチのキャッシュ戦略）はエントリポイント（composition root）で注入する」── `AppLogger` interface + 手動 DI のこの形は、実務で「既存 Node アプリを Workers/エッジへ載せ替える」「ベンダーロックインを避ける」場面で実際に使う。それを小さく実演している
- **テストランタイムの単純さ**: 後述のとおり純粋ロジックの単体テストは Node でも workerd でも結果が同じなので、速い Node プール（Vitest デフォルト）のままにしている

### 二段構えの代償

- エントリが 2 つ + `bootstrap.ts` という間接層が増える
- `devDependencies` が増える（`@hono/node-server` / `pino` / `pino-pretty` / `tsx`）
- **「Node では動くが Workers では落ちる」事故が起きうる**。実際このリポジトリも開発途中で `node:crypto` が Workers で使えない問題に当たり、Web Crypto API へ移行している（コミット履歴参照）。Workers 一本なら原理的に起きないクラスのバグ
- 「Workers 専業なのに `Dockerfile` / `docker-compose.yml` がある」のは一見ちぐはぐ（中身は Supabase ローカルではなくアプリコンテナ用＝ローカル学習の名残）

### 本番最小構成にしたい場合（workerd 単一ランタイムへ畳む）

このリポジトリをテンプレートにして「Workers 専業バックエンド」を作るなら、以下を削れば `wrangler dev` 一本 + staging + production の 3 環境・単一ランタイム構成になります:

1. `app/index.node.ts` / `app/bootstrap.ts` / `app/shared/infrastructure/node-pino-logger.ts` を削除（`bootstrap.ts` の中身は `app/index.workers.ts` に畳む）
2. `app/shared/infrastructure/logger.ts` から pino 分岐を除去（`AppLogger` interface + `createWorkersLogger` + `createSilentLogger` だけにする）
3. 自動テストを [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) に寄せる（テストも `workerd` 内で実行 → 本番と完全パリティ。※ Vitest のバージョンに追従するので対応版の確認・pin が要る場合あり。coverage は `@vitest/coverage-istanbul` 推奨）
4. `@hono/node-server` / `pino` / `pino-pretty` / `tsx` / `Dockerfile` / `docker-compose.yml` を撤去
5. `package.json` の `dev` / `start` / `build` を整理（`dev` は `wrangler dev` に、本番ビルドは `wrangler deploy` が内包）
6. 環境変数の管理も `.dev.vars`（Workers ローカル）+ `wrangler secret`（クラウド）に一本化

### テストを workerd で走らせる価値について

「自動テストも本番と同じ `workerd` で」と思うかもしれませんが、効き目は **テストがランタイム API をどれだけ触るかに比例** します:

- **純粋な domain / application 単体**（Entity・VO・UseCase + in-memory repo）→ ECMAScript そのものなので Node でも workerd でも結果は同じ。workerd で走らせる旨味はほぼ無く、起動が遅くなる・Vitest 版の制約が増えるコストだけ払う
- **infrastructure / integration**（fetch で Supabase REST、Web Crypto、`caches.default`、Hono ルーティング）→ ここは Node と workerd で実際にズレうるので、workerd で走らせる価値がある

なので「全部 workerd」でも「全部 Node」でもなく、**ハイブリッド**（純粋ユニットは Node プール、`infrastructure/` と `__tests__/integration/` は workers プール）が現実解です。本リポジトリは現状シンプルさ優先で全部 Node プールにしていますが、`vitest.config.ts` を 2 プロジェクトに分ければハイブリッドに移行できます。

---

## クイックスタート

### 前提

- **Node.js 22 LTS**（[fnm](https://github.com/Schniz/fnm) 推奨。`.node-version` で自動切替）
- **Docker Desktop**（Supabase ローカルコンテナ用）
- **Supabase CLI**（`npm install -g supabase`）

### セットアップ

```bash
# 1. クローン
git clone https://github.com/meta-taro/Hono-Supabase.git
cd Hono-Supabase

# 2. Node 切替（fnm がインストール済みなら自動で v22 になる）
fnm use

# 3. pnpm を corepack 経由で有効化
corepack enable
corepack prepare pnpm@9.15.0 --activate

# 4. 依存インストール
pnpm install

# 5. 環境変数
cp .env.example .env
# `supabase start` 後に出力される値で .env を更新

# 6. Supabase ローカル起動（PostgreSQL / Auth / Studio）
supabase start

# 7. 開発サーバー起動（ホットリロード）
pnpm dev
```

### 動作確認

```bash
# ヘルスチェック
curl http://localhost:3010/health
# => {"status":"ok","version":"local"}
#    version は Node ローカルでは "local"、Cloudflare Workers では version_metadata
#    バインディング由来のデプロイ済みバージョン ID（段階展開中にどの版が応答したか観察できる）

# Supabase Studio（DB 管理画面）
open http://localhost:54323
```

### Cloudflare Workers ローカル実行（本番ランタイム再現）

`pnpm dev` は Node ランタイム（tsx watch）で開発しますが、本番である Workers V8 Isolate を再現するには `wrangler dev` を使います。

```bash
# .dev.vars を作成（Workers ローカル時の環境変数）
cp .dev.vars.example .dev.vars
# 中身を編集（SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY）

# Workers ランタイムでローカル起動
pnpm wrangler:dev
# => http://localhost:8787 で待ち受け
```

### 本番 / staging（Cloudflare Workers）

`wrangler.toml` は **`--env <name>` 必須運用**（`[env.staging]` / `[env.production]` を明示定義）。
`pnpm wrangler:*` スクリプトに env を埋め込んであるので、素の `wrangler deploy`（env 指定なし）は使わない。

```bash
# 初回のみ: Cloudflare アカウント作成 + ログイン
pnpm wrangler login

# secret 登録（env ごとに 3 回ずつ。secret は Worker 名単位のストア）
pnpm wrangler:secret:staging SUPABASE_URL
pnpm wrangler:secret:staging SUPABASE_ANON_KEY
pnpm wrangler:secret:staging SUPABASE_SERVICE_ROLE_KEY
pnpm wrangler:secret:production SUPABASE_URL
pnpm wrangler:secret:production SUPABASE_ANON_KEY
pnpm wrangler:secret:production SUPABASE_SERVICE_ROLE_KEY

# デプロイ
pnpm wrangler:deploy:staging
pnpm wrangler:deploy:production

# ログ確認（リアルタイム tail）
pnpm wrangler:tail:staging
pnpm wrangler:tail:production
```

---

## 体験用スクリプト（`scripts/`）

学習用に「動かして体感する」ためのスクリプトを `scripts/` に置いています。アプリ本体からは独立していて、消してもサービスには影響しません。

| スクリプト                                                            | 何が体験できるか                                                                                                                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/zero-downtime-watch.ps1`<br>`scripts/zero-downtime-watch.sh` | **ゼロダウンタイムデプロイ**（Phase 7 Step 9 (a)）。Worker の `/health` を 0.2 秒間隔で叩き続けながら別ターミナルでデプロイし、切替の瞬間に 1 リクエストも落ちないことを目視する |

### ゼロダウンタイムデプロイを見る（2 ターミナル）

**ターミナル A — 監視ループ**（`Ctrl+C` で停止）

```powershell
# PowerShell 7（pwsh）が無い環境（Windows 標準の PowerShell 5.1）はこちら
powershell -ExecutionPolicy Bypass -File .\scripts\zero-downtime-watch.ps1
# pwsh があるなら:  pwsh scripts/zero-downtime-watch.ps1
# bash:            bash scripts/zero-downtime-watch.sh
```

**ターミナル B — デプロイ**（A を流したまま）

```powershell
pnpm exec wrangler deployments list --env staging   # いまの稼働バージョンを確認（任意）
pnpm wrangler:deploy:staging                        # ← 新バージョンに即時 100% 切替
pnpm exec wrangler deployments list --env staging   # 新しい deployment が一覧の先頭に出たか確認
```

**ターミナル A に流れる出力（例）**

```
watching https://cake-shop-api-staging.<account>.workers.dev/health  (interval 0.2s, Ctrl+C to stop)
17:12:46.965  200  {"status":"ok"}
17:12:47.734  200  {"status":"ok"}
17:12:47.885  200  {"status":"ok"}
17:12:48.022  200  {"status":"ok"}
...（ターミナル B でデプロイ）...
17:12:49.310  200  {"status":"ok"}
17:12:49.455  200  {"status":"ok"}
```

→ デプロイ前後を通して `200` が途切れず、`>>> ERROR` 行が 1 つも混ざらない ＝ 旧 Isolate → 新 Isolate の切替が無停止で行われた、ということ。`>>> ERROR` が出る場合はデプロイ自体の失敗（secret 不整合で 1101 等）が疑わしいので、その行のメッセージを確認する。

> URL や間隔は引数で変えられます: `... zero-downtime-watch.ps1 -Url https://<本番URL>/health -IntervalSeconds 0.5`

---

## CI/CD・環境構成の指針（実運用想定）

> ここはクリック手順書ではなく **「こう構成してある／してほしい」という運用ポリシー**です。GitHub / Supabase / Cloudflare の画面操作は変わりやすいので、具体的な遷移は各自 AI と対話しながら埋めてください。識別子（プロジェクト ref・アカウントサブドメイン）は「自分の値に差し替えるもの」として `<...>` 表記にしています。

### ブランチモデルとデプロイの対応

| GitHub ブランチ  | 役割     | デプロイ先（Cloudflare Workers）                     | ゲート                                                                                                                  |
| ---------------- | -------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| feature ブランチ | 作業     | （デプロイなし）                                     | PR で CI（`ci.yml`）                                                                                                    |
| `develop`        | 統合     | **staging**（`cake-shop-api-staging`）に push で自動 | なし（即時 100%）                                                                                                       |
| `main`           | リリース | **production**（`cake-shop-api`）に push で          | **手動 approval**（GitHub Environment `production` の Required reviewers）→ `versions upload`(0%) → 承認 → `deploy@100` |

通常の流れ: feature → PR → CI 緑 → `develop` にマージ（= staging に反映）→ 区切りで **`develop`→`main` の PR** を作る → CI 緑 → マージ（= `main` への push）→ `Deploy (production)` が承認待ちで停止 → Actions 画面の「Review deployments」で承認 → 本番 100% 切替。ロールバックは `pnpm exec wrangler rollback --env production`。

ワークフローの実体（`.github/workflows/`）:

| ファイル                | トリガ                         | 中身                                                                                                                                                                                   |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks.yml`            | （再利用部品 `workflow_call`） | `Lint & Typecheck` / `Bundle check (tsup + wrangler dry-run)` / `Test (Vitest + local Supabase)` の並列 3 ジョブ                                                                       |
| `ci.yml`                | `pull_request`                 | `checks.yml` を呼ぶだけ（マージ前の検証）                                                                                                                                              |
| `deploy-staging.yml`    | `push: develop`                | `checks` → `wrangler deploy --env staging`。**本番には一切触れない**                                                                                                                   |
| `deploy-production.yml` | `push: main`                   | `checks` → `wrangler versions upload --env production`(0%) → `release-production`（Environment `production` の承認ゲート）→ `wrangler versions deploy <id>@100 --env production --yes` |

### GitHub 側の前提

- **`main` ブランチ保護**（Settings → Rules → Rulesets）: PR 必須（直 push 禁止）／status checks 必須（`checks / Lint & Typecheck`・`checks / Bundle check (tsup + wrangler dry-run)`・`checks / Test (Vitest + local Supabase)`）／force push 禁止／削除禁止／bypass なし（管理者も例外にしない）。`develop` は普段の作業ブランチなので、つけるなら force push 禁止程度で十分。
- **リポジトリ Secrets**: `CLOUDFLARE_API_TOKEN`（最小権限 = Workers Scripts:Edit 等のテンプレ「Edit Cloudflare Workers」）／`CLOUDFLARE_ACCOUNT_ID`（`wrangler.toml` に `account_id` を書かない方針なので CI で必須）。**Supabase の鍵（`SUPABASE_*`）はここに置かない** — それは Worker の実行環境（`wrangler secret`）の責務。「アプリのシークレットは実行環境へ、CI のシークレットは CI へ」と置き場を分ける。
- **リポジトリ Variables**（任意）: `WORKERS_DEV_SUBDOMAIN` = `<account-subdomain>`（Actions の Environment URL 表示用）。
- **Environments**: `staging`（保護なし）／`production`（Required reviewers を設定 → `release-production` ジョブが「承認待ち」で停止 = 人間の関与点）。fork からの PR には Secrets が渡らない GitHub の仕様 + 本番デプロイは `main` push トリガなので、外部 PR が勝手に本番へ出ることはない。

### Supabase 側の前提

- **環境ごとに別プロジェクト**: production 用と staging 用で**別の Supabase プロジェクト**を立てる（このリポジトリでは production = `Hono-Supabase`、staging = `Hono-Supabase-STG`。ref `<...>` は各自のもの）。ローカルは `supabase start`（OSS セルフホスト、シミュレータではない）。
- **本番データを staging に流さない**: staging のデータは**最初から合成・匿名化済みのシード**（`supabase/seed.staging.sql`）で用意する。準識別子は一般化（例: `placed_at` を日単位に丸める）。本番ダンプを staging にコピーするのは禁止。
- **マイグレーションは前方向のみ**: 既存の `supabase/migrations/*.sql` は編集しない（新規ファイル追加だけ）。リンク済みプロジェクトへ `supabase db push` で適用。マイグレに残したくないアドホック SQL（seed・調査）は `supabase db query --linked -f <file>`（Management API 経由・DB パスワード不要）。
- **鍵の置き場**: `SUPABASE_URL` / `SUPABASE_ANON_KEY`（新方式なら publishable key）/ `SUPABASE_SERVICE_ROLE_KEY`（新方式なら secret key）は **`pnpm wrangler:secret:<env> <NAME>` で Worker ごとに登録**。リポジトリにも GitHub Secrets にも置かない。新方式の secret key は生成直後の 1 回しか全文表示されないので即コピー。
- **アクセス制御の境界は RLS**: `cakes` は SELECT 公開・書込は service_role のみ、`customers` は INSERT 匿名可・SELECT 本人のみ、`orders`/`order_items` は本人のみ。アプリはリクエストごとに anon クライアントを作り JWT を載せて呼ぶ（クライアントを信じない）。
- **メール**: 本番は `enable_confirmations = ON`（＝正しい設定）。ローカルも `supabase/config.toml` で揃える（Phase 8 Step 1 完了）。確認メールのテンプレート・Custom SMTP・確認後リダイレクトの運用は **Phase 8** で引き続き扱う。

### このリポジトリ固有の名前 vs 差し替えるもの

フォークしたとき「これ何？」にならないよう、ドキュメント上の文字列は次の線引き:

- **差し替えるもの（`<...>` プレースホルダ表記）**: Cloudflare の `<account-subdomain>`、Supabase の `<project-ref>` / `<your-project-ref>`、`CLOUDFLARE_ACCOUNT_ID` の中身 — いずれも秘密ではないが、フォーク者は自分の値を使う。
- **そのまま残すもの（構成上の固有名）**: Worker 名 `cake-shop-api` / `cake-shop-api-staging`（`wrangler.toml` の `name`）、Supabase プロジェクト名 `Hono-Supabase` / `Hono-Supabase-STG`、env 名 `staging` / `production` — これらは「このリポジトリの設定値」であって、変えたければ変えればいいと一目で分かる。

---

## 主要コマンド

| コマンド                                           | 用途                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                         | 開発サーバー起動（Node / tsx watch）                                                                                                                            |
| `pnpm build`                                       | 本番ビルド（tsup）                                                                                                                                              |
| `pnpm start`                                       | ビルド済みアプリの起動（Node）                                                                                                                                  |
| `pnpm test`                                        | テスト実行                                                                                                                                                      |
| `pnpm test:coverage`                               | カバレッジ計測（閾値 80%）                                                                                                                                      |
| `pnpm typecheck`                                   | TypeScript 型チェック                                                                                                                                           |
| `pnpm lint` / `pnpm format`                        | ESLint / Prettier                                                                                                                                               |
| `pnpm wrangler:dev`                                | **Workers ローカル実行**（V8 Isolate を再現）                                                                                                                   |
| `pnpm wrangler:deploy:staging`                     | staging 環境（`cake-shop-api-staging`）へデプロイ                                                                                                               |
| `pnpm wrangler:deploy:production`                  | 本番環境（`cake-shop-api`）へデプロイ                                                                                                                           |
| `pnpm wrangler:secret:staging X`                   | staging 環境の secret 登録（`X` = `SUPABASE_URL` 等）                                                                                                           |
| `pnpm wrangler:secret:production X`                | 本番環境の secret 登録                                                                                                                                          |
| `pnpm wrangler:tail:staging`                       | staging Workers のログをリアルタイムで tail                                                                                                                     |
| `pnpm wrangler:tail:production`                    | 本番 Workers のログをリアルタイムで tail                                                                                                                        |
| `supabase start` / `stop`                          | ローカル Supabase の起動 / 停止                                                                                                                                 |
| `supabase db push`                                 | マイグレーション適用（リンク済みプロジェクトに対し）                                                                                                            |
| `supabase db query --linked -f F`                  | リンク済みプロジェクトに SQL ファイル F を実行（Management API 経由・DB パスワード不要）                                                                        |
| `powershell -File scripts/zero-downtime-watch.ps1` | デプロイ中に `/health` を叩き続け無停止切替を観察する体験用ループ（→ [体験用スクリプト](#体験用スクリプトscripts) / bash 版: `scripts/zero-downtime-watch.sh`） |

---

## ディレクトリ構成（DDD-lite）

```
.
├── app/
│   ├── index.node.ts                             # エントリ（Node ローカル開発・テスト用）
│   ├── index.workers.ts                          # エントリ（Cloudflare Workers 本番用）
│   ├── bootstrap.ts                              # 両エントリ共通の組立処理
│   ├── app.ts                                    # Hono インスタンス・ルート集約（ランタイム非依存）
│   ├── modules/                                  # = Bounded Contexts
│   │   ├── cakes/
│   │   │   ├── domain/                           # Entity / VO / Repository interface（純粋層）
│   │   │   ├── application/                      # UseCase（1 ファイル = 1 ユースケース）
│   │   │   ├── infrastructure/                   # Repository 実装（Supabase）
│   │   │   └── presentation/                     # Hono ルート + Zod DTO + Controller
│   │   ├── customers/                            # 同構造
│   │   └── orders/                               # 同構造 + Domain Event
│   ├── shared/                                   # 共有カーネル
│   │   ├── domain/                               # AppError 等
│   │   ├── infrastructure/                       # logger（Workers 互換）/ node-pino-logger（Node 専用）/ Supabase クライアント / JwksFetcher
│   │   └── http/                                 # env 検証 / error-handler / 認証ミドルウェア
│   └── __tests__/integration/                    # 跨り系の統合テスト
├── supabase/
│   ├── migrations/                               # SQL マイグレーション
│   └── seed.sql                                  # 初期データ
├── bruno/                                        # API テストコレクション
├── scripts/                                      # 体験用スクリプト（zero-downtime-watch.ps1 / .sh）
├── CLAUDE.md                                     # AI エージェント向け指示書（規約・進捗）
└── docker-compose.yml                            # アプリ用コンテナ
```

### 依存方向（DDD-lite の中核ルール）

```
presentation → application → domain
                                ↑
              infrastructure ───┘
```

- `domain/` は外側を一切 import しない（DB / HTTP / ロガー禁止）
- `application/` は domain interface 経由で永続化を呼ぶ（具象を知らない）
- `infrastructure/` が domain interface を実装する（Supabase 等）
- コンテキスト間（`cakes` ↔ `orders` 等）の直接参照は禁止

### 永続化モデルの命名規則（`domain` 多義使用の回避）

`domain` という語は **業務概念（Domain Model）専用** に予約します。infrastructure 層に置く「DB 行を表す型」は **`Row` サフィックス** で命名し、`infrastructure/domain/` のようなディレクトリは作りません。

| 種類                  | レイヤ                                | 命名             | 例                               |
| --------------------- | ------------------------------------- | ---------------- | -------------------------------- |
| **Domain Model**      | `domain/`                             | サフィックスなし | `Cake`（振る舞いを持つ Entity）  |
| **Persistence Model** | `infrastructure/`（ファイルローカル） | `*Row`           | `CakeRow`（DB 行のシェイプのみ） |

```typescript
// app/modules/cakes/infrastructure/cake.supabase-repository.ts
interface CakeRow {
  // ← Persistence Model（infrastructure 層に閉じる）
  id: string;
  name: string;
  price: number;
  stock: number;
}
// この型は Repository 内でのみ使い、domain / application には漏らさない
```

**理由**: Hexagonal / Clean / Onion Architecture が共通して採る原則として、`domain` という単語は **コードベースに 1 箇所しか存在してはいけない**。同じ語を別の意味で使うと設計意図が読めなくなり、DB の都合（snake_case / timestamp 文字列等）が業務ルールに漏れる原因になる。本プロジェクトでは `Row` サフィックスで物理的に区別する。

| サフィックス | 意味                                                      |
| ------------ | --------------------------------------------------------- |
| `*Row`       | RDB の 1 行（本プロジェクトの基本）                       |
| `*Schema`    | テーブル構造定義（必要時）                                |
| `*State`     | Aggregate の状態スナップショット（Vernon 流・将来必要時） |

> **禁止**: `infrastructure/domain/` ディレクトリの作成、`Cake`（Persistence Model 用）と `Cake`（Domain Model）の同名衝突、`infrastructure/` から `domain/` の Entity を **データ転送目的で** import すること（変換用に Mapper 経由で参照するのは OK）。

---

## API 設計

### バージョニング

- 業務エンドポイントは **`/v1` 配下に配置**
- 非バージョンに置けるのは `/health` のみ
- 破壊的変更時は `/v2` を新設し、`/v1` は維持

### エンドポイント

| Method | Path             | 認証   | 概要             |
| ------ | ---------------- | ------ | ---------------- |
| GET    | `/health`        | 不要   | ヘルスチェック   |
| GET    | `/v1/cakes`      | 不要   | ケーキ一覧       |
| POST   | `/v1/cakes`      | 管理者 | ケーキ登録       |
| POST   | `/v1/customers`  | 不要   | 顧客サインアップ |
| GET    | `/v1/customers`  | 管理者 | 顧客一覧         |
| POST   | `/v1/orders`     | 必須   | 注文作成         |
| GET    | `/v1/orders/:id` | 本人   | 注文詳細         |

### 統一エラーレスポンス

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "リクエストパラメータが不正です",
    "details": [{ "field": "price", "message": "0より大きい整数を指定してください" }]
  }
}
```

| HTTP | Code                    | 意味                 |
| ---- | ----------------------- | -------------------- |
| 400  | `VALIDATION_ERROR`      | Zod 検証失敗         |
| 401  | `UNAUTHORIZED`          | 認証情報なし／不正   |
| 403  | `FORBIDDEN`             | 権限なし（RLS 違反） |
| 404  | `NOT_FOUND`             | リソースなし         |
| 409  | `CONFLICT`              | 一意制約違反         |
| 500  | `INTERNAL_SERVER_ERROR` | 想定外エラー         |

---

## 動作確認チートシート（ローカル / 本番）

実際に叩いて確認するための `curl` 例。**ベース URL を差し替えれば 3 環境とも同じリクエストで動きます**。

| 環境                | ベース URL                                                      | 起動方法                          |
| ------------------- | --------------------------------------------------------------- | --------------------------------- |
| ローカル（Node）    | `http://localhost:3010`                                         | `pnpm dev`                        |
| ローカル（Workers） | `http://localhost:8787`                                         | `pnpm wrangler:dev`               |
| staging             | `https://cake-shop-api-staging.<account-subdomain>.workers.dev` | `pnpm wrangler:deploy:staging`    |
| production          | `https://cake-shop-api.<account-subdomain>.workers.dev`         | `pnpm wrangler:deploy:production` |

> `<account-subdomain>` は **Cloudflare アカウント単位**で決まる workers.dev のサブドメイン（Worker 単位ではない）。`pnpm exec wrangler whoami` か Cloudflare ダッシュボード（Workers & Pages → 右側の `*.workers.dev` 表示）で確認できる。フォークした人は自分のアカウントの値に読み替えること。

> 以下は `BASE` 変数に上のいずれかを入れて実行する想定。

```bash
BASE=http://localhost:3010                                          # ← 環境に応じて差し替え
# BASE=https://cake-shop-api.<account-subdomain>.workers.dev         # 本番
```

### 認証不要な確認（ここまでは誰でも叩ける）

```bash
# ヘルスチェック（version は Node ローカルなら "local"、Workers ならデプロイ済みバージョン ID）
curl "$BASE/health"
# => {"status":"ok","version":"local"}

# ケーキ一覧（seed.sql の 5 件が返る）
curl "$BASE/v1/cakes"
# => {"cakes":[{"id":"...","name":"ショートケーキ","price":480,"stock":20}, ...]}
```

### 認証フロー（サインアップ → JWT 取得 → 注文）

`POST /v1/orders` などは Supabase Auth が発行する JWT が必要。本 API は JWT を**発行しない**（Supabase Auth の責務）ので、トークンは Supabase の Auth エンドポイントから取る。

```bash
# Supabase プロジェクトの値（ダッシュボード → Project Settings → API）
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon または publishable キー>

# 1) サインアップ（本 API 経由。handle_new_user トリガが customers 行も自動生成）
curl -X POST "$BASE/v1/customers" \
  -H 'Content-Type: application/json' \
  -d '{"name":"テスト太郎","email":"test+demo@example.com","password":"secret-password"}'
# => {"id":"...","name":"テスト太郎","email":"test+demo@example.com"}
#    ※ Supabase 側の「Confirm email」が ON だとここでメール確認が必要。
#      学習用に検証を省くなら Authentication → Providers → Email で OFF にする。

# 2) パスワードグラントで JWT を取得（Supabase Auth を直接叩く）
TOKEN=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"test+demo@example.com","password":"secret-password"}' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
echo "$TOKEN"

# 3) 注文作成（要 Bearer。customerId は body で渡さない＝JWT subject から解決される）
ORDER=$(curl -s -X POST "$BASE/v1/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"cakeId":"11111111-1111-4111-8111-111111111111","quantity":2}]}')
echo "$ORDER"
# => {"id":"...","customerId":"...","status":"PLACED","totalAmount":960,"placedAt":"...","items":[...]}

# 4) 注文詳細（本人のみ。他人の注文 ID を入れると 403 FORBIDDEN）
ORDER_ID=$(echo "$ORDER" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl "$BASE/v1/orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN"
```

### 認証が要る管理系（管理者ロールの JWT が必要）

```bash
# ケーキ登録（管理者ロールでないと 403）
curl -X POST "$BASE/v1/cakes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ガトーフレーズ","price":650,"stock":8}'

# 顧客一覧（管理者のみ）
curl "$BASE/v1/customers" -H "Authorization: Bearer $ADMIN_TOKEN"
```

> Windows PowerShell では `curl` は `Invoke-WebRequest` のエイリアスなので、上記は **Git Bash / WSL** か、`curl.exe`（実体）を明示して実行する。

---

## テスト方針

| 種類                   | ツール                        | 対象                                 | 配置                         | DB                          |
| ---------------------- | ----------------------------- | ------------------------------------ | ---------------------------- | --------------------------- |
| 単体（domain）         | Vitest                        | Entity / VO / Repository interface   | 実装と共置                   | 不要                        |
| 単体（application）    | Vitest                        | UseCase（in-memory repo で差し替え） | 実装と共置                   | 不要                        |
| 単体（infrastructure） | Vitest                        | Repository 実装                      | 実装と共置                   | 必要（Supabase ローカル）   |
| 統合                   | Vitest + Hono `app.request()` | routes / controllers / 跨り系        | `app/__tests__/integration/` | UseCase mock or 実 Supabase |
| E2E                    | Bruno                         | 全エンドポイント疎通                 | `bruno/`                     | 必要                        |

カバレッジ閾値: **80%**（lines / functions / branches / statements 全て）。未達はビルドエラー扱い。

DDD-lite ではドメイン層が DB 非依存になるため、`application/` のテストが**爆速**（in-memory 実装で差し替え可能）。

---

## 実装進捗

- [x] **Phase 1**: 設定ファイル群・プロジェクト初期化
- [x] **Phase 2**: Hono アプリ骨格 + `/health` + 統一エラー形式 + 構造化ログ + env 検証
- [x] **Phase 2.5**: DDD-lite 4 層構造への移行（`shared/` 共有カーネル + `modules/{cakes,customers,orders}/` 骨格）
- [x] **Phase 3**: `cakes` Bounded Context（domain → application → infrastructure → presentation 縦切り完成）
- [x] **Phase 4**: `customers` Bounded Context（同構造）
- [x] **Phase 5**: `orders` Bounded Context（Domain Event + Postgres Function でアトミック在庫減算）
- [x] **Phase 6**: Supabase Auth + RLS + 認証ミドルウェア + OpenAPI 仕上げ
- [x] **Phase 7**: **Cloudflare Workers 化**（本番デプロイ想定の最終段）
  - [x] Step 1〜6: エントリ二系統化 / `wrangler.toml` / `.dev.vars` / Workers 互換ロガー / JWKS DI / Workers ローカル疎通
  - [x] Step 7: 初回本番デプロイ完了（Cloudflare アカウント取得 + Supabase Cloud 連携 + secret 登録 + `wrangler deploy`。`https://cake-shop-api.<account-subdomain>.workers.dev/health` / `/v1/cakes` 200 OK 確認済み）
  - [x] Step 8: 環境分離（`wrangler.toml` に `[env.staging]` / `[env.production]` を明示定義し `--env` 必須運用へ。staging 用に別 Supabase プロジェクト `Hono-Supabase-STG` を作成 + 4 マイグレーション適用 + 「伏せた合成テストデータ」`seed.staging.sql` 投入 + `cake-shop-api-staging` Worker に secret 登録 + デプロイ。`https://cake-shop-api-staging.<account-subdomain>.workers.dev/health` / `/v1/cakes` 動作確認済み）
  - [x] Step 9: **CI/CD + リリース管理を一周**（実運用のリリースフロー体験）
    - (a) `wrangler deploy` 中に curl ループでゼロダウンタイム切替を観察（体験用スクリプト `scripts/zero-downtime-watch.ps1` / `.sh`）
    - (b) `wrangler versions upload`（流量 0）でバージョン作成 → preview URL で動作確認
    - (c) `wrangler versions deploy --percentage 10/50/100` で段階展開（カナリア）
    - (d) わざとバグを入れて 100% リリース → `wrangler rollback` で直前バージョンへ即時巻き戻し
    - (e) GitHub Actions 化 — `develop` push → staging 自動デプロイ（`deploy-staging.yml`）／`main` push → production（`deploy-production.yml`: `versions upload` 0% → Environment `production` の承認ゲート → `deploy@100`）。`main` ブランチ保護（PR 必須・CI 3 チェック必須・force push/削除禁止）も設定。詳細は [CI/CD・環境構成の指針](#cicd環境構成の指針実運用想定) 参照
- [ ] **Phase 8**: **Supabase Auth メール運用**（確認メールのテンプレート / Custom SMTP / 確認後リダイレクト設計）
  - 本番は `enable_confirmations = ON`（＝正しい設定）。「Supabase Auth を使うバックエンド担当」として確認メールのテンプレ更新・Custom SMTP 切替を一周しておく
  - [x] Step 1（2026-05-13 完了）: ローカルの `supabase/config.toml` を `enable_confirmations = true` にして本番に揃え、`POST /v1/customers` → 確認メール（Inbucket/Mailpit http://localhost:54324 で受信・`verify` リンク + 6 桁 OTP を確認）→ 確認リンク 303 リダイレクト + `auth.users.email_confirmed_at` セット → パスワードログインで JWT 取得、までを一周。あわせて確認必須化で顕在化したサインアップ経路の不具合を修正（確認必須だと `auth.signUp()` がセッションを返さず、直後の「トリガ生成 customers 行の読み戻し」が RLS で 404 になる → サインアップ経路の customers 参照だけ service_role の admin クライアント経由に変更）。`site_url` / `additional_redirect_urls` はフロント未稼働のため一旦 `http://127.0.0.1:3010/health` に着地（他のローカル PJT のポート 3000 と衝突させない）
  - [ ] Step 2〜5: 確認メールのテンプレートを `supabase/config.toml` + `supabase/templates/*.html`（リポジトリ管理）で日本語＋ブランド文面に → 確認後リダイレクト設計 → Custom SMTP（Resend 等）へ切替 → 本番反映

---

## 開発ワークフロー

このプロジェクトは **[Claude Code](https://claude.com/claude-code) 主導で開発** しています。

- 規約・禁止パターン・実装手順は [`CLAUDE.md`](./CLAUDE.md) に集約
- フェーズごとに「設計判断」「ハマりやすい落とし穴」を学習サマリーとして蓄積
- TDD（RED → GREEN → REFACTOR）を厳守

---

## ライセンス

[MIT License](./LICENSE)
