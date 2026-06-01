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

| カテゴリ                | 採用                                                                                     | 選定理由                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本番ランタイム**      | **[Cloudflare Workers](https://workers.cloudflare.com/)**（V8 Isolate）                  | グローバルエッジ・ゼロダウンタイムデプロイ・$0〜$5/月クラスの低コスト                                                                                                                                                                                                                                                               |
| **本番ビルド/デプロイ** | **[Wrangler](https://developers.cloudflare.com/workers/wrangler/)**                      | `wrangler deploy` 1 コマンドで本番反映                                                                                                                                                                                                                                                                                              |
| ローカル開発ランタイム  | Node.js 22 LTS                                                                           | TDD・デバッグ・型チェックを Node 上で完結。tsx watch でホットリロード                                                                                                                                                                                                                                                               |
| Framework               | [Hono](https://hono.dev/) 4.x                                                            | 軽量・高速・型安全。**同一コードで Workers / Node / Vercel Edge / Bun / Deno** に展開可能                                                                                                                                                                                                                                           |
| OpenAPI                 | [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) | コードと仕様の二重管理を回避                                                                                                                                                                                                                                                                                                        |
| Validation              | [Zod](https://zod.dev/)                                                                  | TypeScript ネイティブのスキーマ検証                                                                                                                                                                                                                                                                                                 |
| Database                | Supabase (PostgreSQL 15)                                                                 | Auth / RLS / Realtime まで含む BaaS。Workers から **REST 経由**で接続可能                                                                                                                                                                                                                                                           |
| メール配信（本番）      | [Resend](https://resend.com/)（Supabase Auth の Custom SMTP プロバイダ）                 | Supabase 標準メールはレート制限が厳しく本番運用に不向きなため、Cloud の Auth → SMTP に `smtp.resend.com` を登録。確認メール（サインアップ / パスワードリセット等）を実メール送信。無料枠 + ドメイン未認証で `onboarding@resend.dev` を Sender に運用（Phase 8。npm 依存ではなく外部 SaaS 接続先のため `package.json` には現れない） |
| Logger                  | Workers 互換実装（本番）/ [pino](https://getpino.io/) + pino-pretty（ローカル開発）      | 本番（Workers）は `console.log(JSON.stringify(...))` ベースの軽量実装。ローカル開発時のみ pino を `devDependencies` として併用し、整形ログで TDD・デバッグを快適に                                                                                                                                                                  |
| Test                    | [Vitest](https://vitest.dev/)                                                            | Vite ベース、ESM ネイティブ、高速                                                                                                                                                                                                                                                                                                   |
| Package Manager         | pnpm 9.15.0 (via corepack)                                                               | ディスク効率・モノレポ対応・速度                                                                                                                                                                                                                                                                                                    |
| Container               | Docker Compose（アプリのみ・ローカル学習用途）+ Supabase CLI（DB）                       | 本番は Workers なのでコンテナ不要                                                                                                                                                                                                                                                                                                   |

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
- **テストランタイムの忠実さ**: 純粋ロジックの単体テストは Node プールで高速に回し、`infrastructure/` と `__tests__/integration/` は **`@cloudflare/vitest-pool-workers` で本番と同じ workerd 上で実行**するハイブリッド構成（後述）

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

なので「全部 workerd」でも「全部 Node」でもなく、**ハイブリッド**（純粋ユニットは Node プール、`infrastructure/` と `__tests__/integration/` は workers プール）が現実解です。**本リポジトリは Phase 7 / Step 9 後の保留タスクとして 2 プール構成に移行済み**（`vitest.config.ts` の `projects` で `node-unit`（threads）と `workers`（`@cloudflare/vitest-pool-workers`）を分割）。詳細は後述「## テスト方針」を参照してください。

---

## クイックスタート

> **学習は基本的にローカル Supabase（`supabase start`）で行う前提です**。Cloud 側（staging / production）は Phase 完了時のスモークテストや OpenAPI・RLS・メール周りの実機検証用に置いてあるだけで、普段は Free Tier の auto-pause（7 日無アクティビティで停止）を受け入れて寝かせています。Dashboard の `Restore project` ボタンで数分・無料で復活するので、cloud 検証したくなったときに起こしてください。長期 paused から削除されたとしても、本リポジトリは migration + seed を持っているので新規プロジェクトを立て直して当てれば学習を継続できます。

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
- **auto-pause を受け入れる方針**: staging / production の Supabase は Free Tier のため、7 日間アクセスがないと自動 pause される。本プロジェクトは「学習はローカル Supabase 主体」の方針なので keep-alive 等の延命策は入れていない。pause された場合は Dashboard から `Restore project` で復活させる（数分・無料）。万一 90 日経過で削除されても、`supabase/migrations/*.sql` と `supabase/seed*.sql` から新規プロジェクトを立て直して当てれば復活する。「いつでも cloud が叩ける状態」が必要になったら Supabase Pro（$25/月）への昇格を検討する。

### このリポジトリ固有の名前 vs 差し替えるもの

フォークしたとき「これ何？」にならないよう、ドキュメント上の文字列は次の線引き:

- **差し替えるもの（`<...>` プレースホルダ表記）**: Cloudflare の `<account-subdomain>`、Supabase の `<project-ref>` / `<your-project-ref>`、`CLOUDFLARE_ACCOUNT_ID` の中身 — いずれも秘密ではないが、フォーク者は自分の値を使う。
- **そのまま残すもの（構成上の固有名）**: Worker 名 `cake-shop-api` / `cake-shop-api-staging`（`wrangler.toml` の `name`）、Supabase プロジェクト名 `Hono-Supabase` / `Hono-Supabase-STG`、env 名 `staging` / `production` — これらは「このリポジトリの設定値」であって、変えたければ変えればいいと一目で分かる。

---

## 認証メールのリダイレクト設計（Supabase Auth・Phase 8 Step 3）

サインアップ確認メールやパスワードリセットメールの「リンクを踏んだ後どこに着地するか」は、Supabase Auth では **3 つの設定変数の組み合わせ**で決まる。挙動を理解しておかないと「リンクを踏んだら全然違う画面に飛ばされた」「`redirect_to` を指定したのに無視された」といった事故が起きる。

### 3 つの変数とそれぞれの責務

| 変数                                     | 設定場所                                      | 役割                                                                                       |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `site_url`                               | `supabase/config.toml` の `[auth]` セクション | **デフォルトの着地先**。クライアントが `redirect_to` を指定しないときに使われる            |
| `additional_redirect_urls`               | 同上                                          | **許可リスト**。`redirect_to` で指定できる URL を完全一致で列挙（リストに無い URL は拒否） |
| `redirect_to` / `emailRedirectTo` (引数) | クライアントの `auth.signUp({ options })` 等  | **その操作だけの上書き**。`additional_redirect_urls` にマッチした場合のみ有効              |

優先順位は次のとおり:

1. クライアントが `auth.signUp({ options: { emailRedirectTo: 'https://...' } })` で URL を指定
2. その URL が `additional_redirect_urls` のいずれかと**完全一致**するなら、それを使う
3. マッチしない or 指定なしなら **`site_url` にフォールバック**

「許可リストにマッチしないと黙って `site_url` に流される」という挙動が地雷ポイント。クライアント側で `?emailRedirectTo=` を変えても、サーバ側 `additional_redirect_urls` を同時に更新しないと反映されない。

### このリポジトリでの現在値

```toml
# supabase/config.toml
[auth]
site_url = "http://127.0.0.1:3010/health"
additional_redirect_urls = [
  "http://127.0.0.1:3010/health",        # フロント未稼働時のフォールバック着地
  "http://127.0.0.1:3000/auth/callback", # 将来のフロント（Next.js 等）想定
]
```

フロント（Next.js 等）が別リポジトリで未稼働なので、確認リンクの着地先は API 自身の `/health`。ローカルでポート 3000 を別 PJT が使っている事情もあって、衝突を避けるために一旦こうしてある。フロントを実装したら `site_url` を `http://127.0.0.1:3000` に戻し、サインアップ側で `emailRedirectTo: 'http://127.0.0.1:3000/auth/callback'` を渡せばよい（`additional_redirect_urls` には既に登録済み）。

本番（Cloudflare Pages 等にフロントを置く場合）も同様に、ホスト名違いで `additional_redirect_urls` に追加してから、Supabase Cloud ダッシュボードに反映する（または `supabase config push`）。

### PKCE フロー vs Implicit フロー

Supabase Auth は確認後の token 受け渡しに 2 種類のフローを持つ。`@supabase/supabase-js` v2 のデフォルトは **PKCE**。

| フロー       | 着地時の URL 形式                                        | フロント側の処理                                       | 特徴                                                                                                       |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **PKCE**     | `https://.../auth/callback?code=abc123`                  | `supabase.auth.exchangeCodeForSession(code)` を呼ぶ    | code は短命・使い捨て。サーバサイドレンダリング（Next.js Route Handler 等）と相性が良い。**推奨**          |
| **Implicit** | `https://.../auth/callback#access_token=...&type=signup` | `location.hash` から token を取り出して `setSession()` | hash（fragment）は HTTP リクエストに乗らないのでサーバログには漏れないが、ブラウザ履歴に残る。レガシー扱い |

**HTTP 上の決定的な差**: PKCE は `?code=` なので**サーバまで届く**（Hono の middleware でクエリパラメータとして読める）。Implicit は `#access_token=` でブラウザに留まる（**サーバには絶対に届かない**＝Hono 側ではログにすら出ない）。

本リポジトリの確認メールテンプレ（`supabase/templates/confirmation.html`）に埋め込まれている `{{ .ConfirmationURL }}` は Supabase が組み立てるので、フロー選択は `@supabase/supabase-js` のクライアント初期化オプション（`auth.flowType: 'pkce' | 'implicit'`、デフォルト `'pkce'`）で決まる。本プロジェクトは明示設定していない＝**PKCE**。

### フロント不在での実機観察（推奨手順）

フロントを作る前でも、リダイレクトが「期待どおりの URL に・期待どおりの形式で」飛んでいるかは確認できる:

1. `pnpm dev` で API 起動・`supabase start` でローカル Supabase 起動
2. `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3010/v1/customers -ContentType application/json -Body $body` で**新規メール**でサインアップ（既存メールだと 409）
3. Mailpit（http://127.0.0.1:54324）で確認メールを開き、「メールアドレスを確認する」ボタンの **URL を右クリックでコピー**
4. URL は `http://127.0.0.1:54321/auth/v1/verify?token=...&type=signup&redirect_to=http%3A%2F%2F127.0.0.1%3A3010%2Fhealth` の形。`redirect_to` が `site_url` の URL エンコードになっていることを確認
5. ブラウザで URL を開くと: Supabase Auth 側で token を消費 → `auth.users.email_confirmed_at` をセット → 303 で `http://127.0.0.1:3010/health?code=xxx` に着地（PKCE フロー）
6. ブラウザのアドレスバーを見ると `?code=...` の query パラメータが付いている → **これがフロント側で `exchangeCodeForSession` に渡すべき値**
7. `/health` 自体は code を見ないので、API ログには `GET /health 200` が出るだけ。リダイレクトが想定どおり 200 で着地していることをここで確認

> 💡 **`type` パラメータ**: `redirect_to` のすぐ近くに `type=signup` / `type=recovery` / `type=email_change` が付く。フロントの `/auth/callback` ハンドラはこれを見て分岐し、「サインアップ後はダッシュボードへ」「パスワード変更後はパスワード再設定フォームへ」と着地後の遷移を変える。

### フロント有り時の典型実装（理屈の押さえ）

Next.js App Router（別リポジトリ想定）であれば `app/auth/callback/route.ts` を 1 本書けば終わる:

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const type = url.searchParams.get('type'); // 'signup' | 'recovery' | 'email_change'
  if (!code) return NextResponse.redirect(new URL('/login?error=missing_code', url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: () => cookies() }, // 取得した session を cookie に保存
  );
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, url));
  }

  // type ごとに着地先を変えるのが UX 上ベター
  const next =
    type === 'recovery' ? '/account/password' : type === 'signup' ? '/welcome' : '/dashboard';
  return NextResponse.redirect(new URL(next, url));
}
```

ポイント:

- **`exchangeCodeForSession` は 1 回しか成功しない**（code が使い捨て）。リトライ用に GET を投機実行するような UI にしないこと
- **cookie への保存はサーバ側で行う**（`@supabase/ssr` の `createServerClient` を使うとこれが自動）。クライアント JS で `setSession` するパターンは IE 互換などの理由がなければ採用しない
- **`type` 分岐は UX 改善のため**。サインアップ確認直後にいきなりダッシュボードに放り込むと「アカウント作成された手応え」がないので、`/welcome` のような中継ページを挟むのが定石

### 本番（Supabase Cloud）の運用ポイント

ローカル `config.toml` の `site_url` / `additional_redirect_urls` は本番に自動反映**されない**。本番反映の選択肢は 2 つ:

| 方法                                     | 反映先                             | 特徴                                                             |
| ---------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Supabase Dashboard で手動設定            | Authentication → URL Configuration | 画面ポチポチ。Git で履歴管理されない                             |
| `supabase config push --linked` でアップ | リンク済みプロジェクト             | `config.toml` をそのまま本番へ。Git で履歴管理される（**推奨**） |

本リポジトリは production と staging で**別の Supabase プロジェクト**を使うので、`supabase link --project-ref <ref>` で対象を切り替えてから `config push` する。**ローカル用の `127.0.0.1` URL を本番に push しないように**、本番用には別の `config.toml` を持つか、`config push` 前に `site_url` / `additional_redirect_urls` を本番ホスト名に書き換える運用が必要（このリポジトリでは Step 5 で扱う予定）。

---

## ログ運用の学び — JSON 構造化ログの旨味（Phase 9 Step 1/2 学習サマリー）

Phase 9 Step 1（requestId 伝播 + req スコープ child logger）と Step 2（アクセスログミドルウェア）で本番運用に耐えるロギング基盤が一段落した。ここで「なぜ pino 互換 JSON で吐くのか・テキストログでは何ができないのか」を `jq` 体験ベースで残しておく。

### 観察セットアップ（Workers ローカル）

`pnpm wrangler:dev`（V8 Isolate を再現するローカル Workers、port 8787）を tee 付きで起動 → 5 パターン叩いて出力を `access.log` に残す。

```powershell
# 1) tee 付きで起動（ターミナル表示と同時に access.log にも書く）
pnpm wrangler:dev 2>&1 | Tee-Object access.log

# 2) 別ターミナルから 5 本叩く
curl.exe -i http://127.0.0.1:8787/health
curl.exe -i http://127.0.0.1:8787/v1/cakes
curl.exe -i -H "X-Request-Id: trace-experiment-001" http://127.0.0.1:8787/v1/cakes
curl.exe -i http://127.0.0.1:8787/v1/orders/00000000-0000-0000-0000-000000000001
curl.exe -i -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:8787/v1/customers

# 3) JSON 行だけ抽出（wrangler 自身のテキスト行 `[wrangler:info] ...` を除外）
Get-Content access.log | Where-Object { $_ -match '^\{"level"' } | Set-Content json.log
```

**ローカル観察用の罠**: PowerShell の `Tee-Object` はデフォルトでコンソールコードページ（日本語 Windows なら cp932）で書くため、`err.message` の日本語が `???` 化けする。本番（Cloudflare Logs）は UTF-8 そのままで化けないので**設計問題ではない**が、ローカル jq 観察前に下記を投げておくと綺麗:

```powershell
$PSDefaultParameterValues['Tee-Object:Encoding']='utf8'
$PSDefaultParameterValues['Set-Content:Encoding']='utf8'
```

### jq による「フィールド型を保ったクエリ」5 本

PowerShell では `jq 'select(...)'` の内側ダブルクォートが PS のクォート処理で剥がれて jq に届かないことがあるので、クエリは `.jq` ファイルに置いて `-f` で渡すのが安全。

#### (a) 異常系だけ拾う — 数値比較

```jq
select(.status >= 400)
```

→ 4xx/5xx の access-log 行だけ抽出。sed/awk で書くと `grep '"status":4'` のような前方一致になり、`status:500` を漏らさないための個別列挙が必要。**JSON ログなら数値型として比較できる**。

#### (b) 1 リクエストの全ログを串刺し — Step 1/2 の見せ場

```jq
select(.requestId == "b2d1bd52-3554-42a4-9338-0984d0dbc131")
```

→ 同じ requestId で **error-handler 行**（`msg: "Application error"`、`err.stack` 付き）と **access-log 行**（`msg: "request completed"`、`status`、`duration_ms`）の **2 行が並ぶ**。Step 1 で req スコープ child logger を `c.var.logger` に積み、Step 2 もその child logger を引いて吐くようにしたため、**何も意識しなくても全行に requestId が刺さる**。これが今回の設計の最大のリターン。

#### (c) 遅い順 top 5 — sort_by + slice

```jq
map(select(.msg=="request completed"))
| sort_by(-.duration_ms)
| .[0:5]
| .[] | {path, status, duration_ms, requestId}
```

→ パフォーマンス劣化の検出。手元の観察結果でも `X-Request-Id: trace-experiment-001` 付きの `/v1/cakes` が 180ms で 1 位に来た（=「あの遅かったやつどれだっけ」を即引ける）。sed/awk では「フィールド抽出 → 数値 cast → ソート」の 3 段が手作業になり、フィールド順序を変えると全壊する。

#### (d) パス別集計 — group_by + 平均

```jq
map(select(.msg=="request completed"))
| group_by(.path)
| map({path: .[0].path, count: length, avg_duration: (map(.duration_ms) | add / length)})
```

→ SQL の `GROUP BY path` + `AVG(duration_ms)` 相当が 1 行で書ける。出力例:

```json
[
  { "path": "/v1/cakes", "count": 1, "avg_duration": 180 },
  { "path": "/v1/customers", "count": 1, "avg_duration": 2 },
  { "path": "/v1/orders/00000000-0000-0000-0000-000000000001", "count": 1, "avg_duration": 7 }
]
```

#### (e) エラー時の stack だけ取り出す — 入れ子オブジェクトのパス指定

```jq
select(.err) | {requestId, path, status, stack: .err.stack}
```

→ `err.stack` / `err.details[].field` のような **入れ子フィールドにパスで届く**のが JSON ログの強み。フラットなテキストログだと正規表現で stack の境界を切り出す処理が要り、改行・引用符・空白の混入で簡単に壊れる。

### 運用シナリオ — 実際の障害対応で効くフロー

```
1. ユーザー「16:23 ごろ注文が失敗しました」と報告
2. ブラウザ DevTools の Network → レスポンスヘッダ X-Request-Id をコピペしてもらう
3. Cloudflare Logs（or Datadog / Logflare）で `requestId = <ID>` 検索
4. 該当 reqId の 2 行（access-log + error-handler）が即ヒット
5. err.stack と err.details で原因即特定
```

これは **pino-pretty テキストや Hono 標準 `logger()` では成立しない**:

- テキスト `grep <ID>` は ID が path 等に偶然マッチしてノイズを拾う
- 数値条件（`duration_ms > 1000`）は型がないと書けない
- access-log と error-handler のリンクが人間の目視マッチングになる
- クライアントから貰える `X-Request-Id` はキーが構造化されていないと「同じ ID で検索」が単純な文字列マッチに退化する

### JSON ログ採用の恩恵まとめ

| 観点                                             | 効き目                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **手元（jq）**                                   | `>=`, `sort_by`, `group_by` がフィールド型のまま使える。コードが変わってもクエリが壊れない                   |
| **CI / スクリプト**                              | 負荷試験・障害再現の出力をそのまま機械処理。SLO 違反検出を CI に組める                                       |
| **本番（Cloudflare Logs / Datadog / Logflare）** | ブラウザ UI で SQL ライク検索 + ダッシュボード + アラート（Step 4/5 で扱う）                                 |
| **ランタイム共通**                               | Node 開発（pino-pretty 整形）と Workers 本番（`console.log` JSON）で同スキーマ。同じ jq クエリが両環境で通る |

### sed/awk では届かないポイント

- フィールド型を保ったクエリ（`status >= 500` のような数値条件、`duration_ms > 1000`）
- 入れ子オブジェクト（`err.stack` / `err.details[].field`）へのパス指定
- スキーマが安定 ＝ クエリが将来も壊れない運用契約
- `group_by` / `sort_by` / `map` / `select` で SQL 相当の集計が成立

### 次の Step 3/4/5 への接続

- **Step 3（`/health` 充実）**: 同じ JSON スキーマで `db: {ok, latency_ms}` を返し、外形監視 / uptime monitor から拾える形に
- **Step 4（Workers Analytics Engine）**: ここで吐いた structured ログを Analytics Engine に流し、Cloudflare Dashboard でグラフ化
- **Step 5（観測・アラート）**: 当初は「Cloudflare Logs を R2 / 外部 SaaS に送って 5xx 率 1% 超え → Slack」を想定したが、**Logpush も webhook 通知も Free 枠の外**だったため Free で取れる範囲（Workers Logs 検索 + メール通知）に再定義。詳細は [Phase 9 Step 5 — Free 枠の観測・アラート](#phase-9-step-5--free-枠の観測アラート)

---

## Phase 9 Step 5 — Free 枠の観測・アラート

Step 5 は当初「Logpush で Cloudflare Logs を R2 / 外部 SaaS に送出し、Notifications で 5xx 率超過を Slack に飛ばす」設計だった。実装前に課金境界を裏取りしたところ、**送出（Logpush）も webhook 通知も Cloudflare の有償プランが前提**で Free では成立しないと判明したため、Step 4 と同じく **Free 枠で取れる範囲に再定義**してクローズした。

### Cloudflare 観測・通知の課金境界（2026-05-20 裏取り）

| 手段                                                 | Free 可否 | 必要プラン                |
| ---------------------------------------------------- | --------- | ------------------------- |
| **Workers Logs**（Dashboard でログ検索 / live tail） | ✅ 可     | Free / Paid 両方          |
| **Logpush**（R2 / Datadog 等へ送出）                 | ❌ 不可   | **Workers Paid（$5/月）** |
| Notifications → メール（Workers 使用量・週次・CPU）  | △ 限定可  | Free（種別が限定）        |
| Notifications → webhook（Slack 等）                  | ❌ 不可   | **Pro 以上**              |
| Notifications → PagerDuty                            | ❌ 不可   | Business 以上             |

出典: [Workers Logs docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) / [Available Notifications](https://developers.cloudflare.com/notifications/notification-available/)

> 教訓: Step 4 の「書き込み=Free / 読み出し=Paid」に続き、観測スタックの **"送出・通知" 側も基本 Paid 境界**にある。Free だけで観測を一周するなら「Workers Logs を Dashboard で検索する」が事実上の天井になる。

### 実装（コード）

`wrangler.toml` の `[observability]` を3スコープ（top-level / staging / production）とも明示化し、`head_sampling_rate = 1` を追記した。Workers Logs 自体は以前から `enabled = true` 済みだったので、追加したのは**サンプリングのノブの可視化**と「学習中は低トラフィックなので全件保持。Free 枠の日次取り込み上限に当たったら 0.1 等へ絞る」という Why コメント。

### 観測体験 — 「わざと 5xx を出して Workers Logs で追う」

「わざと 5xx を出してアラートが飛ぶ」演習は Free 枠では成立しない（5xx 率アラートは Notifications の Free 種別に存在しない）。そこで **「わざと 5xx を出して Workers Logs から追跡する」に置換**した。Step 1（requestId 伝播）/ Step 2（アクセスログ）で仕込んだ構造化フィールドが、ここで「障害を検索して特定する」形で初めて回収される。

手順（staging で実施）:

1. `pnpm wrangler:deploy:staging` で staging に反映（`[observability]` 込み）
2. わざと 5xx を誘発する。例: 存在しない注文 ID を本人トークンで叩く / 一時的に 500 を返す経路を踏む（`pnpm wrangler:tail:staging` を別端末で開いておくと即座に流れる）
3. Cloudflare Dashboard → Workers & Pages → 対象 Worker → **Observability / Logs** を開く
4. `level = 50`（error）や `status >= 500` で絞り込み、該当リクエストの `requestId` を特定
5. その `requestId` で全ログを引き直し、1 リクエストの始端〜終端（access-log の `duration_ms` / `status` 含む）を時系列で追えることを確認

レスポンスヘッダ `X-Request-Id` に同じ ID が反射されるので、**クライアントが障害報告時に貼った ID から Workers Logs を一発で引ける**運用がここで完成する。

### メール通知（Free で設定できる範囲）

Cloudflare Dashboard → 右上アカウントメニュー → **Notifications** → Add で、Free プランでも **Workers 使用量系**（週次サマリ / CPU 使用量閾値）のメール通知を設定できる。「エラー率」ベースのアラートは Free 種別に無いので設定できない（Paid 移行時の繰越）。

### Paid 移行時の繰越

- Logpush → R2 送出（→ DuckDB / 外部 SaaS で SQL 集計）
- 5xx 率の閾値アラート + Slack webhook 連携
- Step 4 の Analytics Engine SQL 検証（route 正規化が `/v1/orders/:id` に集約され生 UUID が出ないことの end-to-end 確認）

いずれも Workers Paid（$5/月）移行で一括解消できる。

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
| `pnpm verify`                                      | 手動の総合チェック（`lint` + `typecheck` + `format:check` + `test:coverage` を順に実行）。push 前や PR 前のセルフ確認に使う（カバレッジ閾値 80% も同時に検査）  |

---

## ローカルの品質ゲート（pre-commit / verify）

CI で初めて lint / format 違反に気づくと「ローカルでは緑なのにリモートで赤」になりやすい。**手元で芽を摘む二段構え** を入れてあります。

### 1 段目: pre-commit フック（自動）— husky + lint-staged

`git commit` の瞬間に **ステージされたファイルだけ** に対して整形と簡易 lint をかける。コミット作者がフォーマットを意識しなくても、リポジトリに入る瞬間に揃う。

- **何が走るか**: `package.json` の `lint-staged` セクションで定義
  - `*.{ts,tsx,js,mjs,cjs}` → `eslint --fix` ＋ `prettier --write`
  - `*.{json,md,yml,yaml,toml,html,css}` → `prettier --write --ignore-unknown`（`.prettierignore` で `supabase/templates/` 等は除外）
- **どう動くか**: `.husky/pre-commit` が `pnpm exec lint-staged` を起動 → 自動修正後、修正済みファイルが自動で再ステージ → そのままコミットが続行する
- **失敗時の挙動**: 修正不能なエラー（型エラー級の lint 違反など）はコミットを中断。`lint-staged` が **元の状態に git stash でリストアしてくれる** ので、未コミット作業が壊れることはない
- **初回セットアップ**: `pnpm install` 時に `prepare` スクリプトが `husky` を実行して `.husky/` を有効化するので、リポジトリを clone した人が追加で何かする必要はない

> なぜ pre-commit は **format 系（自動修正で済むもの）に絞っているか**: 「重い検査（typecheck・全 test）まで走らせると、コミットのたびに数十秒〜数分待たされて結局フックを `--no-verify` で潰されがち」という現場あるあるを回避するため。重い検査は次の `pnpm verify` と CI に任せる。

### 2 段目: 手動コマンド `pnpm verify`（push 前のセルフ確認）

```bash
pnpm verify   # = pnpm lint && pnpm typecheck && pnpm format:check && pnpm test:coverage
```

CI（`.github/workflows/checks.yml`）が回しているのと同じセットをローカルで一気に流せる。**push する前に手元で 1 回叩く習慣** をつけておくと、CI がレッドになる事故をほぼゼロにできる。

### 3 段目: GitHub Actions の `checks.yml`（PR / deploy）

PR と各環境への deploy ワークフローが必ず `checks.yml`（`workflow_call`）を呼び、Lint & Typecheck / Bundle check / Test を再実行する。`main` のブランチ保護でこれら 3 ジョブを必須 status checks に設定済なので、**CI が緑にならないと本番に出ない**。

> **JS action のランタイムについて**: 各ワークフローの top-level env に `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` を置き、`checkout` / `setup-node` / `pnpm` / `supabase` / `wrangler-action` などの JS action を **Node 24 ランタイムで起動**している（GitHub が 2026/6/2 に強制切替する前の公式 opt-in）。これは **action 本体の実行環境の話**で、プロジェクト自身が使う Node（`setup-node` の `node-version: 22`、ローカル開発と揃える LTS）とは別物。強制切替後はこの env は no-op になるので削除してよい。

### 緊急脱出（フックを一時的にバイパス）

仕組み上 `git commit --no-verify` でスキップは可能ですが、**通常運用では絶対に使わない**。`--no-verify` した瞬間に CI が赤くなって結局直すことになるだけ。

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
│   │   ├── orders/                               # 同構造 + Domain Event
│   │   ├── webhooks/                             # 同構造（注文確定イベントの外部 POST）
│   │   └── reviews/                              # 同構造（ケーキへのレビュー投稿・一覧・集計）
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

| Method | Path                                            | 認証   | 概要                                                       |
| ------ | ----------------------------------------------- | ------ | ---------------------------------------------------------- |
| GET    | `/health`                                       | 不要   | ヘルスチェック                                             |
| GET    | `/v1/cakes`                                     | 不要   | ケーキ一覧（カーソルページネーション）                     |
| GET    | `/v1/cakes/:id`                                 | 不要   | ケーキ 1 件（ETag 付き）                                   |
| POST   | `/v1/cakes`                                     | 管理者 | ケーキ登録                                                 |
| PATCH  | `/v1/cakes/:id`                                 | 管理者 | 在庫更新（楽観ロック・If-Match 必須）                      |
| POST   | `/v1/customers`                                 | 不要   | 顧客サインアップ                                           |
| GET    | `/v1/customers`                                 | 管理者 | 顧客一覧                                                   |
| POST   | `/v1/orders`                                    | 必須   | 注文作成                                                   |
| GET    | `/v1/orders`                                    | 本人   | 自分の注文一覧（カーソルページネーション）                 |
| GET    | `/v1/orders/:id`                                | 本人   | 注文詳細                                                   |
| POST   | `/v1/webhooks/subscriptions`                    | 管理者 | Webhook 配信先登録（secret を 1 度だけ開示）               |
| GET    | `/v1/webhooks/subscriptions`                    | 管理者 | Webhook 配信先一覧                                         |
| DELETE | `/v1/webhooks/subscriptions/:id`                | 管理者 | Webhook 配信先削除（履歴 cascade）                         |
| GET    | `/v1/webhooks/subscriptions/:id/deliveries`     | 管理者 | サブスクリプション別の配信履歴                             |
| GET    | `/v1/cakes/:cake_id/reviews`                    | 不要   | ケーキのレビュー一覧（カーソル + 集計同梱）                |
| POST   | `/v1/cakes/:cake_id/reviews`                    | 必須   | ケーキへのレビュー投稿（Idempotency-Key 必須）             |
| POST   | `/v1/cakes/:cake_id/reviews/:review_id/helpful` | 必須   | ケーキレビューに「役立った」を付ける（冪等・自己投票 403） |
| DELETE | `/v1/cakes/:cake_id/reviews/:review_id/helpful` | 必須   | ケーキレビューの「役立った」を取り消す（冪等）             |
| GET    | `/v1/shop/reviews`                              | 不要   | 店舗レビュー一覧（単一店舗・カーソル + 集計）              |
| POST   | `/v1/shop/reviews`                              | 必須   | 店舗レビュー投稿（Idempotency-Key 必須）                   |
| POST   | `/v1/shop/reviews/:review_id/helpful`           | 必須   | 店舗レビューに「役立った」を付ける（冪等・自己投票 403）   |
| DELETE | `/v1/shop/reviews/:review_id/helpful`           | 必須   | 店舗レビューの「役立った」を取り消す（冪等）               |

### `GET /v1/cakes` のページネーション仕様（Phase 10 Step 1）

ケーキ一覧は **カーソルベース（キーセット）ページネーション**を採用する。`offset`/`page` 方式ではなく、
`(name, id)` の複合キーを使った keyset 方式にすることで、データ追加・削除があってもページ境界がズレず、件数が増えても性能が劣化しない（offset と違い飛ばし読みのコストが無い）。

**クエリパラメータ**:

| パラメータ | 型      | 既定 | 制約           | 説明                                                        |
| ---------- | ------- | ---- | -------------- | ----------------------------------------------------------- |
| `limit`    | integer | 20   | 1〜100         | 1 ページの件数。範囲外は `400 VALIDATION_ERROR`             |
| `after`    | string  | —    | 不透明トークン | 前ページの `next_cursor` をそのまま渡す。先頭ページでは省略 |

**レスポンス形状**:

```json
{
  "cakes": [{ "id": "...", "name": "...", "price": 480, "stock": 20 }],
  "next_cursor": "eyJuYW1lIjoi...",
  "has_more": true
}
```

- `next_cursor`: 次ページ取得用の**不透明（opaque）カーソル**。`{ name, id }` を base64url で包んだトークンで、クライアントは中身を解釈せずそのまま `after` に渡す。最終ページでは `null`。
- `has_more`: 次ページの有無（`next_cursor !== null` と同義の利便フラグ）。
- 次ページがある場合は **RFC 5988 `Link` ヘッダ**（`rel="next"`）にも次ページ URL を載せる（ボディと二重提供）。

**設計判断のメモ**:

- `name` は一意でないため、カーソルは `(name, id)` の**複合キー**にする。`name` 単独だと同名ケーキがページ境界をまたいだとき重複・取りこぼしが起きる。
- カーソルは UTF-8 を `TextEncoder`/`TextDecoder` 経由で base64url 化する（`btoa`/`atob` は Latin1 限定で日本語のケーキ名が壊れる。Workers には `Buffer` が無いため Web 標準 API で完結させる）。
- 改竄・壊れた `after` は Zod 検証で弾いて `400 VALIDATION_ERROR` に倒す（500 にしない＝クライアント起因の入力だから）。
- コーデックは `app/shared/http/cursor.ts` に汎用化（`encodeCursor`/`decodeCursor`）。`/v1/orders` 一覧（Step 1.5）でも再利用する。

### `GET /v1/cakes` のソート・フィルタ仕様（Phase 10 Step 2）

Step 1 のカーソルページネーションに、**ソート**（並び替え）と**フィルタ**（絞り込み）を追加した。

**追加クエリパラメータ**:

| パラメータ  | 型      | 既定   | 制約 / 例        | 説明                                                                                          |
| ----------- | ------- | ------ | ---------------- | --------------------------------------------------------------------------------------------- |
| `sort`      | string  | `name` | `-price,name`    | 並び順。`-` 接頭辞で降順、カンマ区切りで複数指定。許可: `name`/`price`/`stock`                |
| `available` | boolean | —      | `true` / `false` | 在庫の有無で絞る（`true`=在庫あり`stock>0` / `false`=在庫切れ`stock=0`）                      |
| `min_price` | integer | —      | 1〜1,000,000     | 価格の下限（この値を含む）                                                                    |
| `max_price` | integer | —      | 1〜1,000,000     | 価格の上限（この値を含む）                                                                    |
| `q`         | string  | —      | 1〜100 文字      | ケーキ名のあいまい検索（Step 3 で `ILIKE` → **PGroonga 全文検索**に置換。下記 Step 3 節参照） |

例: `GET /v1/cakes?sort=-price,name&available=true&min_price=500&q=いちご`

**設計判断のメモ**:

- **ソート構文 `-price,name`** は Stripe / GitHub などの主流に倣う。`-` 接頭辞で降順、無印（または `+`）で昇順、カンマ区切りで複数フィールド。許可外フィールド・重複フィールドは `400 VALIDATION_ERROR`。パーサは `app/shared/http/sort.ts`（`parseSortParam` / `canonicalizeSort`）に汎用化。
- **末尾に必ず `id` 昇順を tiebreaker として付与**する。`price` や `stock` は一意でないため、これが無いとキーセットの全順序が確定せずページ境界で重複・取りこぼしが起きる。
- **カーソルに「発行時の sort」を埋め込む**。並び順が変わるとキーセットの「続き」の意味も変わるため、`after` を渡すときの `sort` がカーソル発行時と違えば `400`（「sort を変えるなら先頭ページから取り直せ」）。これでページ途中の並び替えによる不整合を防ぐ。
- **フィルタはカーソルに埋め込まない**（主流 API と同じ）。フィルタはソート済みストリームを絞るだけでキーセットの整合は壊れない。ただしページ途中でフィルタを変えると見え方が変わる点はクライアント責務として割り切る。
- `min_price > max_price` は controller で `400 VALIDATION_ERROR`。
- `q` は Step 2 時点では `ILIKE` 部分一致だったが、Step 3 で **PGroonga 全文検索**に置き換えた（理由・使い分けは下記 Step 3 節）。
- 多カラム + 方向混在のキーセットは `(c1 OP1 v1) OR (c1=v1 AND c2 OP2 v2) OR …` を `infrastructure` 層で `or(...)` 展開する（`OP` は昇順 `gt` / 降順 `lt`）。in-memory 実装も同じ全順序を再現してユニットで検証。

### `GET /v1/cakes` のあいまい検索仕様（Phase 10 Step 3）

`q` パラメータを **PGroonga 全文検索**に置き換えた（Step 2 までは `ILIKE` 部分一致）。日本語のケーキ名を、2 文字クエリやひらがな部分一致でも拾えるようにするのが目的。Step 1/2 のソート・キーセットページネーションはそのまま維持する（あいまい検索＋キーセット、関連度ランキングはしない）。

**全文検索の選択肢と使い分け**:

| 方式             | 仕組み                                  | 日本語     | 強み                                                | 弱み                                                                                                                                                        |
| ---------------- | --------------------------------------- | ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIKE`/`ILIKE`   | 単純部分一致（前方一致以外は索引不可）  | △ 文字単位 | 実装が最小・依存ゼロ                                | `%foo%` は索引が効かず全件スキャン。表記ゆれ非対応                                                                                                          |
| **pg_trgm**      | 3 文字トライグラム類似度（GIN 索引）    | △ 文字単位 | `ILIKE` を索引で高速化・タイポ許容（`similarity`）  | ① **1〜2 文字クエリは索引に乗らない**（3 文字未満）② 短語 vs 長名の類似度が低く `word_similarity` が要る ③ 苺/いちご/イチゴ は別トライグラム ④ スコアが粗い |
| tsvector（標準） | 形態素 → lexeme・ステミング・ランキング | ✕ **不可** | 英語等の本格 FTS・ランキング                        | **標準パーサは日本語をトークン分割できない**（単語境界が無い）→ 日本語名には使えない                                                                        |
| **PGroonga** ✅  | Groonga ベース FTS（N-gram + 形態素）   | ◎ 得意     | 2 文字・ひらがな部分一致 OK・全角半角を正規化・高速 | 索引サイズが pg_trgm より大きい・拡張のインストールが要る（Supabase ローカル/ホスト両対応）                                                                 |

→ **学習リポジトリだが「日本語検索の実運用での現実解」を体験する**ため PGroonga を採用。`苺`↔`いちご`↔`イチゴ` の異表記吸収はノーマライザだけでは賄えない（シノニム辞書が要る）点は割り切り、N-gram 部分一致までを範囲とする。

**アーキテクチャ（なぜ RPC か）**:

- PostgREST のクエリビルダ（`supabase-js`）は `eq`/`gt`/`ilike`/`fts` 等は表現できるが、**PGroonga 演算子 `&@`（全文一致）を直接呼べない**。そこで `place_order` と同じく Postgres Function に閉じ込め、`.rpc('search_cakes', {...})` で呼ぶ。
- `search_cakes(p_q, p_available, p_min_price, p_max_price, p_sort, p_after, p_limit)` は **検索 + フィルタ + 多段ソート + キーセット**をすべて関数側の動的 SQL で処理する（`supabase/migrations/0005_cakes_pgroonga_search.sql`）。並び替えフィールドは関数内でホワイトリスト検証してから `%I`（識別子）、値は `%L`（リテラル）で `format()` し、識別子と値を分離して SQL インジェクションを構造的に防ぐ。`security invoker`（`cakes` は RLS で全員 SELECT 可なので権限昇格は不要）。
- repository は `nameSearch` の有無で経路を分岐: **あり → `search_cakes` RPC / なし → 従来の PostgREST**。`limit+1` 取得で「次ページ有無」を判定するのは両経路共通。
- in-memory 実装（ユニットテスト）は PGroonga の N-gram 一致を JS で再現できないため**部分一致で近似**する。実 DB の検索挙動は `workers` プール（`infrastructure`/`integration`）の実 Supabase テストで担保する（2 文字「抹茶」・ひらがな「いちご」部分一致を検証）。

例: `GET /v1/cakes?q=いちご&sort=-price&available=true`

### `GET /v1/cakes/:id` + `PATCH /v1/cakes/:id` の楽観ロック仕様（Phase 10 Step 4）

在庫更新（追加発注・棚卸し）で「他の管理者が先に更新していたのに気付かず上書きする」**lost update** を防ぐため、`ETag` + 条件付きリクエストによる**楽観ロック**を導入した。

**フロー（read-modify-write）**:

1. `GET /v1/cakes/:id`（**認証不要**）でケーキ 1 件を取得。レスポンスヘッダ `ETag: W/"<version>"` に現在の版が載る。
2. `PATCH /v1/cakes/:id`（**管理者専用**）で `If-Match: W/"<version>"` を付けて `{ "stock": <新在庫> }` を送る。
3. サーバは `UPDATE cakes SET stock = ? WHERE id = ? AND version = ?` を実行。版が一致した行だけ更新され、`version` は DB トリガで +1 採番される。レスポンスは更新後の `ETag`（新しい版）を返す。

**設計判断**:

- **version 整数カラム + DB トリガ採番**: 楽観ロックの版は `cakes.version`（`supabase/migrations/0006_cakes_optimistic_lock.sql`）。`bump_version()` を `BEFORE UPDATE` トリガにすることで、SQL を直接叩く経路や別サービスからの更新でも必ず版が単調増加する（不変条件を DB に一元化）。`ETag` はキャッシュ検証だけでなく**並行更新の競合検知にも使える**（HTTP の条件付きリクエストの本来の用途の一つ）。
- **Weak ETag（`W/"7"`）**: 表現のバイト単位一致ではなく「意味的に同じ版か」を見るため weak validator を採用。コーデックは `app/shared/http/etag.ts`（`formatETag` / `parseIfMatch`）。`*` ワイルドカードは「版の一致」が目的にそぐわないため `400` で拒否。
- **PATCH で stock 絶対値（冪等）**: 在庫の**差分**ではなく**絶対値**を送る。同じリクエストを再送しても結果が変わらない冪等な部分更新になり、リトライが安全。
- **412 / 428（RFC 準拠）**: 版不一致は `412 PRECONDITION_FAILED`（RFC 7232）、`If-Match` 欠落は `428 PRECONDITION_REQUIRED`（RFC 6585）。428 で「無条件上書き」を構造的に禁止する（クライアントに必ず版の提示を強制）。
- **404 と 412 の切り分け**: UseCase はまず `findById` で存在を確認（無ければ 404）し、その後 version 付き `updateStock` を実行。競合の最終判定は DB の `WHERE version = ?`（原子的）に委ねるので、`findById`〜`updateStock` 間に割り込まれても lost update は起きない。
- **ルーティング順**: `GET /:id`（public）は `adminGuard` を貼る前に登録して認証不要を保ち、`PATCH /:id`（admin）は `adminGuard` を `/:id` に貼ってから登録する（Hono は `.use()` の登録順でミドルウェア適用範囲が決まる。`POST /` と同じパターン）。

例:

```
GET   /v1/cakes/<id>                       → 200, ETag: W/"1"
PATCH /v1/cakes/<id>  If-Match: W/"1"       → 200, ETag: W/"2"（成功・版前進）
PATCH /v1/cakes/<id>  If-Match: W/"1"（再） → 412 PRECONDITION_FAILED（競合）
PATCH /v1/cakes/<id>  （If-Match なし）     → 428 PRECONDITION_REQUIRED
```

### `/v1/*` の Rate Limit 仕様（Phase 10 Step 5）

突発的な大量リクエスト（ログイン総当たり・スクレイピング暴走・無料枠の費用爆発）を**エッジで即時に弾く**ため、Cloudflare Workers の Rate Limiting binding を採用した。binding は呼び出し時点で同期判定（`success: boolean`）を返し、上流のアプリ・DB に負荷が伝播しないのが利点。`hono/rate-limiter` のようなアプリ内カウンタでは isolate 跨ぎの正確性が出ない（Workers は各リージョンで isolate が乱立し、メモリ共有もしない）ため、Cloudflare 側に窓を任せる方針を採った。

**3 つの binding と閾値**（`wrangler.toml` の `[[ratelimits]]` で宣言）:

| binding                | period | limit | キー戦略                         | 適用先                                                    | 狙い                                                                                                |
| ---------------------- | ------ | ----- | -------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `LIMITER_PUBLIC_READ`  | 10s    | 100   | `ip:<cf-connecting-ip>`          | `GET /v1/cakes` / `GET /v1/cakes/:id`                     | 公開読み取り。スクレイパ抑制。正常ユーザの 100 リク / 10 秒は事実上の天井で UX を阻害しない         |
| `LIMITER_PUBLIC_WRITE` | 60s    | 5     | `ip:<cf-connecting-ip>`          | `POST /v1/customers`（サインアップ）                      | **認証前**のため IP キー。Resend / Supabase Auth が送る確認メールの大量発信＝費用攻撃を 60 秒に絞る |
| `LIMITER_AUTH_WRITE`   | 10s    | 10    | `user:<jwt.sub>` (未認証なら IP) | `POST /v1/cakes` / `PATCH /v1/cakes/:id` / `/v1/orders/*` | 認証済みユーザ単位。誤連打・自作スクリプトの暴走を 1 秒 1 回程度に収める                            |

> **Workers binding の制約**: `period` は **`10s` または `60s` のみ**。`1h` 単位の長窓は別途 Durable Object 等が要る。学習段階では 2 値で十分とした。

**429 レスポンス**:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "リクエスト数が上限を超えました",
    "details": [{ "field": "Retry-After", "message": "10" }]
  }
}
```

- `Retry-After: 10`（または 60）を必ず付ける。Cloudflare の `limit()` は `{ success }` しか返さないため、**`retryAfterSec` は middleware factory が wrangler.toml の period から焼き込む**（period と Retry-After を 1 箇所で揃える）。
- 統一エラー本文の `details[0].field = 'Retry-After'` にも同値を載せ、JSON だけ読むクライアントでも待機秒を取れるようにする。

**実装メモ**:

- **`RateLimiter` ポート**: `app/shared/http/rate-limiter.ts` に `limit({ key }) → Promise<{ success }>` の最小 interface を定義。Cloudflare の `RateLimit` 型と**構造的に互換**なのでラッパは不要。テスト用に `InMemoryRateLimiter`（固定ウィンドウ + `now()` 差し替え）を併設し、node-unit プールで middleware 単体テストを高速に回す。
- **`restrictToMethods` ヘルパ**: Hono の `router.use(path, mw)` は**メソッドを区別しない**ため、`GET /v1/cakes`（public）と `POST /v1/cakes`（admin）のように同一パス（`/`）に**メソッド別の異なる limiter** を割り当てたいケースで困る。`restrictToMethods(['GET'], publicRead)` のようにメソッド配列でゲートする薄いラッパを置き、メソッド外のリクエストは limiter を呼ばずに `next()` で素通しする（カウンタも消費しない）。
- **DI**: `bootstrap.ts` の `buildRateLimitMiddlewares()` が 3 binding を 3 つの `MiddlewareHandler` に組み立てる。binding 未注入なら `noopRateLimitMiddleware` を返すので、Node ローカル / テスト最小経路では rate-limit を完全に外せる（`createApp({ rateLimitMiddlewares })` を省略するだけ）。
- **キー戦略**: `cf-connecting-ip` は Cloudflare がエッジで注入する**改竄不能**ヘッダ（クライアントが任意に詰めても上書きされる）。`X-Forwarded-For` は信頼しない。`userOrIpKey` は `c.get('user')?.id` を優先し、未認証フォールバックで IP を使う。
- **`orders` は全パス authWrite**: 一覧 / 詳細 / 注文作成すべて認証必須なので、router の `*` に一発で乗せる。binding 名 `LIMITER_AUTH_WRITE` の "write" は wrangler.toml 都合の名残で、実態は「user キーで limit する authenticated 系」。

**staging で見る方法**:

```bash
# 1) staging に向ける
BASE=https://cake-shop-api-staging.<account-subdomain>.workers.dev

# 2) わざと閾値を超える（公開 GET を 110 回叩く）
for i in $(seq 1 110); do curl -s -o /dev/null -w "%{http_code}\n" "$BASE/v1/cakes" ; done | sort | uniq -c
# 期待: 200 が 100 件、429 が 10 件

# 3) Retry-After を確認
curl -i "$BASE/v1/cakes" | grep -iE '^(HTTP|retry-after)'
```

`pnpm wrangler:tail:staging` を別ターミナルで開いておくと、429 になった requestId / path / status を構造化ログから検索できる（Phase 9 Step 1/2 で仕込んだ req スコープロガーの恩恵）。

> **メモ（テスト時の `wrangler.toml` 警告）**: `@cloudflare/vitest-pool-workers@0.8.x` が同梱する wrangler は古めで、workers プール起動時に `Unexpected fields found in top-level field: "ratelimits"` という warning を吐く。これは vitest プール側の bundled wrangler が `[[ratelimits]]` を未認知なだけで、**実デプロイ（`pnpm wrangler:deploy:*`）は最新の `wrangler` が解釈するため問題ない**。pool 側が追随したら自動で消える（vitest 4.x + pool 0.15.x 移行待ち）。

### `POST /v1/*` の Idempotency-Key 仕様（Phase 10 Step 6）

ネットワーク再送や「送信ボタン連打」による二重作成（同じ注文が 2 件、同じ顧客が 2 件、同じケーキが 2 件）を防ぐため、全 POST エンドポイントで **Stripe スタイルの `Idempotency-Key` ヘッダを必須化**した。クライアントは「論理的に 1 回の操作」につき 1 つの key を生成（UUID v4 等）し、ネットワーク失敗時は **同じ key + 同じ body** で再送する。サーバは初回のレスポンスを 24h 永続化しておき、再送が来たら handler を再実行せずにそのまま返す。

**契約**:

| ケース                                    | 挙動                                                                     | レスポンス                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `Idempotency-Key` ヘッダ未指定 / 形式不正 | 即弾く（1〜255 文字・ASCII 印字可能のみ）                                | `400 IDEMPOTENCY_KEY_REQUIRED`                                 |
| 初回（同じ key の予約なし）               | handler 実行 → レスポンスを `idempotency_keys` に保存                    | 通常のステータス（201 等）                                     |
| 同じ key + 同じ body の再送               | handler を呼ばず保存済みレスポンスをそのまま返す                         | 初回と同じ status + body + `Idempotency-Replayed: true` ヘッダ |
| 同じ key + 違う body                      | クライアントの key 使い回しミス                                          | `422 IDEMPOTENCY_KEY_REUSED`                                   |
| 同じ key で 1 回目がまだ完了していない    | 並行リクエスト or 直前の処理が応答待ち。クライアントはバックオフして再送 | `409 IDEMPOTENCY_IN_PROGRESS`                                  |

**adopted owner（隔離スコープ）**:

| エンドポイント       | owner_type | owner_id ソース                 | 理由                                                                        |
| -------------------- | ---------- | ------------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/orders`    | `user`     | JWT subject（`auth.users.id`）  | 認証必須。「ユーザ A の key=k1」と「ユーザ B の key=k1」は完全に独立        |
| `POST /v1/cakes`     | `user`     | JWT subject（admin の user.id） | 管理者操作。adminGuard 後に動くので user 確定済み                           |
| `POST /v1/customers` | `ip`       | `cf-connecting-ip` ヘッダ       | サインアップは**未認証**経路のため IP で隔離（Cloudflare が改竄不能で注入） |

複合主キーは `(key, owner_type, owner_id, scope)` で、`scope = 'POST /v1/orders'` 等のエンドポイント固有文字列を加えることで「同じ key を `POST /v1/orders` と `POST /v1/customers` で誤って共有しても衝突しない」保証を作る。

**永続化レイアウト**（migration `0007_idempotency_keys.sql`）:

```sql
create table public.idempotency_keys (
  key             text          not null,
  owner_type      text          not null check (owner_type in ('user','ip')),
  owner_id        text          not null,
  scope           text          not null,
  request_hash    text          not null,
  status          text          not null check (status in ('in_progress','completed')) default 'in_progress',
  response_status int,
  response_body   jsonb,
  created_at      timestamptz   not null default now(),
  completed_at    timestamptz,
  expires_at      timestamptz   not null default now() + interval '24 hours',
  primary key (key, owner_type, owner_id, scope)
);
alter table public.idempotency_keys enable row level security;
-- 明示ポリシー無し → service_role 専用。anon / authenticated からは見えない
create index on public.idempotency_keys (expires_at);
```

**実装の要点**:

- **port + 2 実装**: `IdempotencyStore`（`app/shared/infrastructure/idempotency-store.ts`）は `tryReserve(record) → { kind: 'inserted'|'in_progress'|'mismatch'|'replay' }` + `complete(record, payload)` の 2 メソッド。`InMemoryIdempotencyStore` は node-unit プールの高速テスト用、`SupabaseIdempotencyStore`（`app/shared/infrastructure/supabase-idempotency-store.ts`）が本番経路。
- **アトミック予約**: `SupabaseIdempotencyStore.tryReserve` は PostgREST の `.upsert(..., { ignoreDuplicates: true, onConflict: 'key,owner_type,owner_id,scope' })` で **`INSERT … ON CONFLICT DO NOTHING RETURNING *`** 相当を 1 リクエストで打つ。挿入できれば `inserted`、衝突なら既存行を SELECT して expired / replay / in_progress / mismatch を判定。「最初の completed が勝つ」semantics は `complete` 側で `WHERE status='in_progress'` を付けて担保。
- **canonical JSON + SHA-256**: middleware（`app/shared/http/idempotency.middleware.ts`）は `await c.req.text()` で生 body を取り、JSON ならキーを再帰的に sort してから `JSON.stringify` → Web Crypto `crypto.subtle.digest('SHA-256', ...)` → hex で `request_hash` を作る。プロパティ順序が違うだけの「同じ意味の body」を別ハッシュにしない。`node:crypto` には依存しないので Workers でそのまま動く。
- **replay レスポンス**: `c.newResponse(JSON.stringify(body), status, { 'Content-Type': 'application/json; charset=UTF-8' })` で組み立て、`Idempotency-Replayed: true` ヘッダを乗せる（観測性確保。クライアントは「実際に再実行された」のか「キャッシュから返った」のか区別できる）。
- **挿入順**: `rate-limit → auth/admin guard → idempotency → handler` の順に貼る。未認証で 401 を返す経路は idempotency まで届かず store を消費しない。route 側は `restrictToMethods(['POST'], deps.idempotency)` で同パス共有の GET 経路に副作用を出さない（cakes の `GET /` と `POST /` は同じ Hono path）。
- **DI**: `bootstrap.ts` の `buildIdempotencyMiddlewares()` が `IdempotencyStore` から 3 つの `MiddlewareHandler` を組み立てる。store 未注入時は `noopIdempotencyMiddleware` を返し、Node ローカル / テスト最小経路では完全に外せる。
- **コミット時の Co-Authored-By**: 学習プロジェクト方針で付けない（global settings.json で disabled）。

**curl での確認例**:

```bash
# 初回 → 201（Idempotency-Replayed なし）
curl -i -X POST http://localhost:3010/v1/customers \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 5e1b0c70-7c3f-4c0b-a4f4-1c1a1d1a1f01' \
  -d '{"name":"Alice","email":"alice@example.com","password":"Strong@P4ss"}'
# 同じ key + 同じ body → 201 + Idempotency-Replayed: true（DB は 1 件のまま）
curl -i -X POST http://localhost:3010/v1/customers \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 5e1b0c70-7c3f-4c0b-a4f4-1c1a1d1a1f01' \
  -d '{"name":"Alice","email":"alice@example.com","password":"Strong@P4ss"}'
# 同じ key + 違う body → 422 IDEMPOTENCY_KEY_REUSED
curl -i -X POST http://localhost:3010/v1/customers \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 5e1b0c70-7c3f-4c0b-a4f4-1c1a1d1a1f01' \
  -d '{"name":"Mallory","email":"mallory@example.com","password":"Other@P4ss"}'
```

**未対応事項（学習段階の割り切り）**:

- **expired 行の物理削除**: `expires_at < now()` の行は `tryReserve` 内で検出して上書きするが、`pg_cron` 等での定期 GC は入れていない。テーブルは増え続けるので、長期運用では cron + DELETE を追加する。
- **冪等な GET / DELETE**: GET は元から副作用なし、DELETE は冪等な操作として扱える（RFC 7231）ので Idempotency-Key を強制していない。
- **5xx の replay**: handler が 5xx を返した場合もそのまま保存して replay する素朴な実装。Stripe は 5xx だけは保存しない（クライアントが再試行できる）方針だが、本実装では「保存されたエラーは別 key で再試行」する運用にしている（学習段階の簡素化）。
- **DB トランザクション**: `tryReserve` と handler 実行は別接続のため、handler が DB トランザクションを張る場合でも idempotency 行と業務行は別コミット。学習段階では許容（「同じ key の再送はサーバが捌くが、別 key で並行に来た同一意味の操作は handler 側で 409/重複検知する」前提）。

### `POST /v1/orders` → Webhook 配信仕様（Phase 10 Step 7）

注文確定（`POST /v1/orders` 成功）をトリガに、登録済みの外部 URL へ **HMAC-SHA256 署名付きの JSON ペイロード**を POST する。配信は **fire-and-forget + 指数バックオフ retry**で、API レスポンス時刻には影響を与えない（業務の主系と副系を分離する）。

**配信先の登録**（`POST /v1/webhooks/subscriptions`、管理者専用）:

```bash
# 配信先 URL を 1 件登録 → secret が 1 度だけ返る（DB には保存するが GET では返さない）
curl -i -X POST http://localhost:3010/v1/webhooks/subscriptions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <admin JWT>" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"url":"https://webhook.site/<your-uuid>","description":"開発確認用"}'
# 201 Created
# { "id":"...", "url":"https://webhook.site/<...>", "secret":"<hex 64 文字>", "active":true, ... }
```

| Method | Path                                        | 概要                                                                   |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/v1/webhooks/subscriptions`                | 配信先登録（secret を 1 度だけ返す。失念したら再登録）                 |
| GET    | `/v1/webhooks/subscriptions`                | 配信先一覧（secret は出ない。`created_at DESC, id DESC` でキーセット） |
| DELETE | `/v1/webhooks/subscriptions/:id`            | 配信先削除（紐づく `webhook_deliveries` 行は cascade で消える）        |
| GET    | `/v1/webhooks/subscriptions/:id/deliveries` | サブスクリプション別の配信履歴（`status` / `attempts` / `last_error`） |

**配信ペイロード**（`Content-Type: application/json`、body は固定スナップショット）:

```json
{
  "event_id": "8f6e4a23-...",
  "event_type": "order.placed",
  "occurred_at": "2026-05-26T01:23:45.000Z",
  "data": {
    "order_id": "...",
    "customer_id": "...",
    "items": [{ "cake_id": "...", "quantity": 2, "unit_price": 500 }],
    "total_amount": 1000
  }
}
```

**配信リクエスト時に乗るヘッダ**:

| ヘッダ                 | 内容                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Content-Type`         | `application/json; charset=UTF-8`                                                                                |
| `X-Webhook-Event-Id`   | ペイロードの `event_id`（受信側で **冪等処理キー**として使う）                                                   |
| `X-Webhook-Event-Type` | `order.placed` 等                                                                                                |
| `X-Webhook-Signature`  | **Stripe スタイル** — `t=<unix_seconds>,v1=<hex>`。`v1` は `HMAC-SHA256(secret, "${t}.${raw_body}")` の hex 表記 |

**受信側での検証手順**（Node + Web Crypto 想定）:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

// 1. ヘッダから t と v1 を取り出す
const [tField, v1Field] = req.headers['x-webhook-signature'].split(',');
const t = tField.slice(2);
const v1 = v1Field.slice(3);

// 2. 自分の secret で signed_payload を再計算
const signedPayload = `${t}.${rawBody}`; // rawBody は req.body の文字列そのまま
const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

// 3. 定数時間比較
if (!timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))) {
  return res.status(401).end();
}

// 4. t の許容差分（例: ±5 分）でリプレイ攻撃を排除
if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) {
  return res.status(401).end();
}
```

**指数バックオフ retry スケジュール**（`app/modules/webhooks/domain/webhook-delivery.ts`）:

| 試行回数 | 結果         | 次回 retry までの待機 | `status`    |
| -------- | ------------ | --------------------- | ----------- |
| 1        | 失敗         | 1 分                  | `failed`    |
| 2        | 失敗         | 5 分                  | `failed`    |
| 3        | 失敗         | 30 分                 | `failed`    |
| 4        | 失敗         | 4 時間                | `failed`    |
| 5        | 失敗         | 24 時間               | `failed`    |
| 6        | 失敗         | —（恒久停止）         | `dead`      |
| いずれか | 2xx/3xx 成功 | —                     | `succeeded` |

合計猶予 ≒ **約 29 時間**（短期障害を吸収しつつ、復旧不能と判断したら `dead` に倒して停止する）。`status='dead'` の行も `webhook_deliveries` に残るので、運用者は `GET /v1/webhooks/subscriptions/:id/deliveries` で原因（`last_error`）を確認できる。

**配信ループの起動方式（Free プラン制約への対応）**:

- 本プロジェクトは Workers Free プランで動かす前提のため、Cron Triggers を「常時動作」と想定するのは過剰。代わりに **リクエスト駆動の dispatch ミドルウェア**（`app/shared/http/webhook-dispatch.middleware.ts`）を採用。
- 仕組み: 各リクエストの handler 完了後に `c.executionCtx.waitUntil(dispatchPendingDeliveries(...))` で **pending / failed かつ `next_retry_at <= now()` の delivery を最大 5 件**配信する。
- これにより「API トラフィックがある限り retry は自然に進む」「リクエストのレスポンス時刻には影響しない」の両立が成立。トラフィック皆無の時間帯はラウンドが回らないが、学習プロジェクトの趣旨では許容（必要なら後付けで Cron Triggers / Durable Object Alarm に差し替え可能）。

**設計上の不変条件**:

- **`UNIQUE (event_id, subscription_id)`**（migration `0008_webhooks.sql`）で「同じ event を同じ subscription に二重発火しない」を **DB 制約で構造的に保証**。EventPublisher が万一二度走っても deliveries が増殖しない。
- **`webhook_deliveries.payload` は INSERT 時に snapshot**（jsonb 列）。retry のたびに発火元の Order を再読み込みしないため、発火後に Order が変わっても配信されるのは「発火時点のスナップショット」。
- **副系の失敗は主系を巻き戻さない**: `place-order.usecase` 内で `publisher.publish()` を `try/catch` で握り、warn ログだけ残して注文確定の成功は維持する（多重防御として publisher 実装側も throw しない）。
- **RLS は service_role 専用**（`webhook_subscriptions` / `webhook_deliveries` ともに明示ポリシーなし）。管理 API は admin client（`SUPABASE_SERVICE_ROLE_KEY`）経由で操作する設計に合わせる。

**公開リポジトリの安全性**:

- `seed.sql` / `seed.staging.sql` には subscription を入れない。`webhook_subscriptions` が 0 件 = 配信 0 件 = フォーク者がそのまま `pnpm seed` を打っても外部 URL に意図せず HTTP リクエストを飛ばすことはない。
- `secret` は `INSERT` 時のみレスポンスに含めて返却し、`GET /v1/webhooks/subscriptions` では出さない（再表示不可。失念したら再登録）。

**失敗カテゴリと挙動**:

| 配信先の応答 / 状態 | 挙動                                                          |
| ------------------- | ------------------------------------------------------------- |
| 2xx / 3xx           | `status='succeeded'`、`succeeded_at=now()`、retry 終了        |
| 4xx / 5xx           | `status='failed'`、`attempts++`、`last_error='HTTP <status>'` |
| ネットワーク不到達  | `status='failed'`、`last_error=<例外メッセージ>`              |
| `timeoutMs` 超過    | `AbortController.abort()` で打ち切り → `status='failed'`      |
| 6 回目失敗          | `status='dead'`、`next_retry_at=null`（以降は拾われない）     |

**試したいとき（ローカル動作確認のレシピ）**:

- **[webhook.site](https://webhook.site/)** — 一時受信用の使い捨て URL を発行してくれる。`POST /v1/webhooks/subscriptions` に `https://webhook.site/<uuid>` を登録し、`POST /v1/orders` を叩くと、ブラウザ上で **ヘッダ（`X-Webhook-Signature` 含む）と body** をリアルタイム観察できる。
- **Slack incoming webhook** — Slack ワークスペースの Incoming Webhook URL をそのまま登録すれば配信が来ること自体は確認できるが、**Slack 側は Stripe スタイル署名をそのまま検証しない**ため、受信メッセージの整形は別途必要（学習目的の到達確認には十分）。
- **dispatch を即時に進める** — 待ち時間ゼロで挙動を見たい場合は、続けて `GET /health` 等の軽い API を叩くと、その request の `waitUntil` で次ラウンドの delivery が処理される（リクエスト駆動方式）。

**設計上の割り切り（学習段階）**:

- **配信成功の at-least-once**: 受信側が 2xx を返した直後に DB 更新前に Workers が落ちると、retry でもう一度同じ event_id が届く可能性がある。**受信側は `X-Webhook-Event-Id` で冪等化する**前提（Stripe / GitHub と同じ慣例）。
- **dead 行の自動削除なし**: `status='dead'` の行は手動 GC（運用者の `DELETE` or 削除 API）まで残る。学習段階ではテーブル監査のため意図的に残す方針。
- **Cron Triggers 未使用**: 上述の通り Free プラン制約で「リクエスト駆動」に倒している。完全に静かな時間帯があると retry の進行が止まる。

### `GET /v1/orders` のページネーション仕様（Phase 10 Step 1.5）

注文一覧は **認証ユーザー本人の注文のみ**を、**カーソルベース（キーセット）ページネーション**で新しい順に返す。Step 1（cakes）のコーデックをそのまま再利用し、カーソルのキーだけ `(placed_at, id)` に差し替えた構成。

**クエリパラメータ**（cakes と同形）:

| パラメータ | 型      | 既定 | 制約           | 説明                                                        |
| ---------- | ------- | ---- | -------------- | ----------------------------------------------------------- |
| `limit`    | integer | 20   | 1〜100         | 1 ページの件数。範囲外は `400 VALIDATION_ERROR`             |
| `after`    | string  | —    | 不透明トークン | 前ページの `next_cursor` をそのまま渡す。先頭ページでは省略 |

**レスポンス形状**:

```json
{
  "orders": [
    {
      "id": "...",
      "customerId": "...",
      "status": "PLACED",
      "totalAmount": 1200,
      "placedAt": "2026-05-06T10:00:00.000Z",
      "items": []
    }
  ],
  "next_cursor": "eyJwbGFjZWRBdCI6...",
  "has_more": true
}
```

- 並び順は **新しい順**（`placed_at DESC, id DESC`）。`next_cursor` は `{ placedAt, id }` を base64url で包んだ不透明トークンで、最終ページでは `null`。
- 次ページがある場合は **RFC 5988 `Link` ヘッダ**（`rel="next"`）にも次ページ URL を載せる（cakes と同じ二重提供）。

**設計判断のメモ**:

- `placed_at` は同時刻の注文がありうる**非一意キー**のため、カーソルは `(placed_at, id)` の**複合キー**にする（cakes が `name` 非一意ゆえ `(name, id)` にしたのと同じ理屈）。`placed_at` は ISO 8601 UTC 文字列で持ち、辞書順 = 時系列順になるよう揃える。
- 本人フィルタは**多重防御**: RLS ポリシー `orders_select_self`（`customers.auth_user_id = auth.uid()` または admin）で DB が一次的に絞り、加えて repository でも明示的に `customer_id` で絞る。これにより `service_role`（RLS バイパス）クライアントが注入された経路でも他人の注文が漏れない。
- `authUserId → 業務 customerId` の解決は controller が `resolveCustomerId` ポート経由で行う（POST と同じ。対応する customer がいなければ `404 NOT_FOUND`）。
- 改竄・壊れた `after` は Zod 検証で `400 VALIDATION_ERROR` に倒す（cakes と同じ）。

### `GET /v1/cakes/:cake_id/reviews` + `POST /v1/cakes/:cake_id/reviews` のレビュー仕様（Phase 11 Step 1）

ケーキへのレビューを **投稿（POST・認証 + Idempotency-Key 必須）** と **一覧 + 集計（GET・公開）** の 2 本立てで提供する。レスポンス 1 本に「1 ページ分のレビュー + 集計（count / average / 星別 distribution）」を同梱して、商品詳細画面が API を 2 回叩かなくて済むようにする。

**`POST /v1/cakes/:cake_id/reviews`**

| 制約                    | 値                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 認証                    | 必須（`Authorization: Bearer <JWT>`）                                                                                         |
| `Idempotency-Key`       | 必須（Stripe スタイル・Phase 10 Step 6 と同じ仕様。scope = `'POST /v1/cakes/:cake_id/reviews'`、owner = `user`）              |
| Body                    | `{ rating: 1..5, title: 1..100 字, body: 1..2000 字 }`                                                                        |
| 重複投稿                | 同一 `(cake_id, user_id)` で既に published / hidden のレビューがあれば `409 REVIEW_CONFLICT`                                  |
| `is_verified_purchaser` | **投稿時点の snapshot** として保存（後で履歴が変わっても表示は動かない）。判定は `has_purchased(cake_id, user_id)` RPC を使う |
| 401 / 400 / 422         | 未認証 / バリデーション失敗（rating 範囲外・title/body 空・cake_id 非 UUID）/ 同 key + 違う body                              |

**`GET /v1/cakes/:cake_id/reviews`**

| クエリパラメータ | 型      | 既定     | 制約                | 説明                                                                             |
| ---------------- | ------- | -------- | ------------------- | -------------------------------------------------------------------------------- |
| `sort`           | string  | `newest` | `newest \| helpful` | 並び順。`helpful` は `helpful_count DESC, created_at DESC, id DESC` の多段ソート |
| `limit`          | integer | 20       | 1〜100              | 1 ページの件数                                                                   |
| `filter_rating`  | integer | —        | 1〜5                | 星別フィルタ                                                                     |
| `verified_only`  | string  | —        | `true \| false`     | 購入済みバッジ付きのみに絞る                                                     |
| `after`          | string  | —        | 不透明トークン      | 前ページの `next_cursor`。先頭ページでは省略                                     |

**レスポンス**:

```json
{
  "reviews": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "cake_id": "11111111-1111-4111-8111-111111111111",
      "user_id": "auth-user-abcdef",
      "rating": 5,
      "title": "とても美味しかった",
      "body": "生クリームの甘さが絶妙でした。",
      "is_verified_purchaser": true,
      "helpful_count": 12,
      "created_at": "2026-05-27T10:00:00.000Z"
    }
  ],
  "next_cursor": "eyJzb3J0...",
  "has_more": true,
  "stats": {
    "count": 123,
    "average": 4.5,
    "distribution": { "1": 3, "2": 5, "3": 20, "4": 40, "5": 55 }
  }
}
```

**設計判断のメモ**:

- **カーソルは sort 別に複合キーを切り替える**: `newest` は `(created_at, id)`、`helpful` は `(helpful_count, created_at, id)`。Phase 10 Step 2 と同じく**カーソルに正規化 sort 文字列を埋め込み**、次ページ取得時に sort が一致しなければ `400`（フィルタは不透明トークンに含めない）。`id` は常に最終 tiebreaker（全順序を保証）。
- **集計を 1 リクエストに同梱**: count / average / 星別 distribution を repository 側で同じ where 句で再利用して N+1 にならない設計。0 件のときは `average=null`（クライアントが「まだ評価なし」を明示的に表現できるように）、distribution は 0 件の星も 0 を返す（フロントが空配列の特殊扱いを書かなくて済む）。
- **購入済みバッジは投稿時点の snapshot**: 後で注文がキャンセル/返金された場合でも、過去の「購入したうえでのレビュー」表記は維持される（履歴の真実を尊重する／表示が遡及して動くのは UX 上望ましくない）。判定は `has_purchased(cake_id, user_id)` RPC（`security invoker`・注文 status='placed' の order_items を見る・service_role からのみ呼ばれる port + adapter）。
- **重複投稿の構造的禁止**: スキーマに `UNIQUE(cake_id, user_id) WHERE status='published'` 部分インデックスを張り、DB レベルでも防御（アプリ側の `findByCakeIdAndUserId` 事前チェックと多重防御）。`hidden` 状態のレビューは UNIQUE 制約から外し、モデレータが「公開取り消し」した場合でも本人の再投稿を許可する（Step 4 通報フローで使う）。
- **コンテキスト跨ぎ禁止対応**: `reviews` は `cakes` / `orders` の Entity を import せず、`CakeId` は reviews ローカルの VO として再宣言、購入済み判定だけを port 経由で受ける（DDD-lite のコンテキスト境界を保つ）。
- **ルーターは cakeRouter と同じ `/v1/cakes` プレフィックスに別ルーターとして並べる**: Hono の trie は `/v1/cakes/:id`（cakeRouter）と `/v1/cakes/:cake_id/reviews`（reviewsRouter）を別パスとして区別するので衝突しない。GET / POST が同じパスを共有するため、`restrictToMethods` ヘルパで authGuard / Idempotency を POST だけにゲートし、GET は public 経路を保つ。

### `GET /v1/shop/reviews` + `POST /v1/shop/reviews` の店舗レビュー仕様（Phase 11 Step 2）

ケーキ個別ではなく **店舗そのもの** へのレビューを、Step 1 と同じ「投稿（POST・認証 + Idempotency-Key 必須）」+「一覧 + 集計（GET・公開）」の 2 本立てで提供する。本プロジェクトは **単一店舗**を前提とするため、`shop_id` も `cake_id` も持たず、テーブル・エンドポイントともに店舗を 1 つだけ表す（`shop_reviews` テーブル / `/v1/shop/reviews`）。`reviews` Bounded Context の中に `ShopReview` を **別 Aggregate / 別テーブル**として追加し、ケーキレビュー（Step 1）には一切手を入れない。

**`POST /v1/shop/reviews`**

| 制約                   | 値                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 認証                   | 必須（`Authorization: Bearer <JWT>`）                                                                                 |
| `Idempotency-Key`      | 必須（Stripe スタイル・Phase 10 Step 6 と同じ仕様。scope = `'POST /v1/shop/reviews'`、owner = `user`）                |
| Body                   | `{ rating: 1..5, title: 1..100 字, body: 1..2000 字 }`                                                                |
| 重複投稿               | 同一 `user_id` で既に `removed` でないレビューがあれば `409 CONFLICT`（1 ユーザー 1 店舗レビュー）                    |
| `is_verified_customer` | **投稿時点の snapshot**。任意ケーキの `PLACED` 注文が 1 件でもあれば `true`。判定は `has_ordered(p_auth_user_id)` RPC |
| 401 / 400 / 422        | 未認証 / バリデーション失敗（rating 範囲外・title/body 空）/ 同 key + 違う body                                       |

**`GET /v1/shop/reviews`**: クエリパラメータ・レスポンス形状は Step 1（ケーキレビュー）と同一。ただしレビュー要素に **`cake_id` は含まれない**（単一店舗のため対象 ID が不要）。

```json
{
  "reviews": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "user_id": "auth-user-abcdef",
      "rating": 5,
      "title": "雰囲気も接客も最高",
      "body": "店員さんが親切で居心地が良かったです。",
      "is_verified_customer": true,
      "helpful_count": 8,
      "created_at": "2026-05-29T10:00:00.000Z"
    }
  ],
  "next_cursor": "eyJzb3J0...",
  "has_more": true,
  "stats": {
    "count": 42,
    "average": 4.6,
    "distribution": { "1": 1, "2": 1, "3": 4, "4": 10, "5": 26 }
  }
}
```

**設計判断のメモ**:

- **単一店舗 = `shop_id` を持たない**: 「店舗が増えたら」を先取りして `shop_id` を入れると、本来 1 行で済む集計に常に `WHERE shop_id = ?` が付き回り、フロントも常にダミー ID を引き回す羽目になる。多店舗化は破壊的変更を伴う別 Phase の判断とし、現時点は単一店舗に振り切る（YAGNI）。
- **利用実績バッジ `is_verified_customer`**: ケーキレビューの「この商品を買った人か」とは粒度が違い、「**この店で何か 1 つでも買ったことがある客か**」を表す。判定は `has_ordered(p_auth_user_id)` RPC（`security invoker`・`orders.status='PLACED'` を `customers` 経由で `auth.users.id` に紐付け）。Step 1 と同じく投稿時点の snapshot で固定する。
- **重複投稿の構造的禁止**: `UNIQUE(user_id) WHERE status <> 'removed'` 部分インデックスで「1 ユーザー 1 店舗レビュー」を DB レベルで保証（`removed` 行は対象外＝モデレーション削除後の再投稿を許可）。アプリ側 `existsActiveByUser` の事前チェックと多重防御。
- **コンテキスト跨ぎ禁止対応**: Step 1 同様、`orders` の Entity を import せず、注文実績の判定だけを `OrderHistoryChecker` port 経由で受ける（Supabase 実装が `has_ordered` RPC を呼ぶ）。
- **ルーターは `/v1/shop` プレフィックスの独立ルーターとしてマウント**: cakeRouter / reviewsRouter とパスが重ならないので衝突しない。GET / POST が `/reviews` を共有するため、`restrictToMethods` で authGuard / Idempotency を POST だけにゲートする点も Step 1 と同じ。

### `/health` の応答仕様（Phase 9 Step 3a）

`/health` は **DB 到達性も含めた 3 状態のヘルスチェック**を返す（外形監視・uptime monitor の連携前提）。

**レスポンス形状**:

```json
{
  "status": "ok" | "degraded" | "down",
  "version": "<deployment id>",
  "db": { "ok": true, "latency_ms": 42 }
}
```

**状態と HTTP マッピング**:

| status     | HTTP | 条件                                                                   | 監視側の扱い                               |
| ---------- | ---- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `ok`       | 200  | probe 成功 かつ `db.latency_ms ≤ 800`                                  | 正常                                       |
| `degraded` | 200  | probe 成功 だが `db.latency_ms > 800`                                  | 警告（pager は鳴らさない・観察用）         |
| `down`     | 503  | probe 失敗（タイムアウト・Supabase REST エラー・接続不到達のいずれか） | 障害（uptime monitor から pager に乗せる） |

**probe 実装**:

- bootstrap で anon Supabase client を 1 回だけ作り、`cakes` を `select('id').limit(1).abortSignal(AbortSignal.timeout(1500))` で叩く
- `cakes` を選ぶ理由 = RLS が public read を許可している唯一のテーブル（auth 不要で probe 可能）
- 失敗パス（タイムアウト・HTTP エラー・接続不到達）は全て catch して `{ ok: false, latency_ms: <経過時間> }` に丸める

**閾値（Step 3a で仮置き → Step 3b で実測検証済・据え置き）**:

- probe timeout: `1500ms`
- degraded boundary: `latency_ms > 800`
- 連続失敗集計なし（stateless）— Phase 9 Step 5 で結論: 閾値アラートは Free 枠外（Paid）なので、連続失敗判定は `/health` に持たせず外形監視側に委ねる方針で確定

**テストでの差し替え**: `createApp({ healthDbProbe })` に fake probe を注入できる DI 形状にしてあるので、4 状態（ok / degraded / down(タイムアウト相当) / down(クエリエラー相当)）を全部ユニットテストで網羅できる。probe を省略すれば従来通り `{ status: "ok", version }` のみの最小 health（既存テスト互換）。

#### Step 3b 実測体験のまとめ（2026-05-18）

ローカル（Node + Supabase ローカル）で 3 シナリオを実際に踏み、閾値の妥当性を確認した。コードは各シナリオで一時改変 → 観察 → revert する運用（恒久的な env 化はしない）。

| シナリオ             | 引き起こし方                        | 観察結果                                                   | 学び                                                                                                 |
| -------------------- | ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| ベースライン         | 何もしない                          | HTTP 200 / `ok` / `latency_ms: 36–290`（初回が遅め）       | ウォームアップ込みでも 290ms。定常で 36–66ms。`DEGRADED_LATENCY_MS=800` は十分マージンあり           |
| 1. degraded          | `DEGRADED_LATENCY_MS` を 5 に下げる | HTTP 200 / `degraded` / `db.ok:true` / `latency_ms: 36`    | 「DB 到達しているが遅い」を pager を鳴らさず警告だけ出せる挙動が確認できた                           |
| 2. down(timeout)     | `PROBE_TIMEOUT_MS` を 50 に下げる   | HTTP 503 / `down` / `db.ok:false` / `latency_ms: 59`       | timeout から +9ms（abort 後処理）で probe 失敗。`AbortSignal.timeout` が REST 呼び出しを正しく切れる |
| 3. down(unreachable) | `supabase stop` で REST 自体を停止  | HTTP 503 / `down` / `db.ok:false` / **`latency_ms: 1518`** | 接続拒否（ECONNREFUSED）が即返らず **`PROBE_TIMEOUT_MS=1500` でタイムアウト発火**                    |

**シナリオ 3 の重要な学び**: ローカルの Docker Desktop / WSL2 ネットワークスタックは、停止したコンテナのポートに対して **TCP RST を即時に返さず、SYN を吸い込んで応答しない**挙動を示すことがある。これは本番でも「上流が応答しないハング系障害」として頻発するシナリオで、もし `AbortSignal.timeout` を設定していなければ `/health` 自体が OS デフォルトの fetch timeout（数十秒〜120秒）まで pending してしまう。外形監視・uptime monitor からの health check が詰まる最悪のシナリオを避けるための **probe timeout の存在意義**がここで実測できた。

**閾値の最終判断**:

- `DEGRADED_LATENCY_MS = 800`: 据え置き。ベースライン定常 36–66ms / 初回 290ms から十分なマージン。本番（Supabase Cloud）はネットワーク往復が増えるため定常 latency は上がる想定だが、それでも 800ms ならまだ余裕がある
- `PROBE_TIMEOUT_MS = 1500`: 据え置き。ハング系を 1.5 秒で検知できるバランス。短すぎると正常な遅延を down に倒してしまい、長すぎるとハング検知が遅れる
- stateless 設計: 据え置きで確定。Phase 9 Step 5 で「閾値アラートは Cloudflare の Free 枠外（Paid 必須）」と裏取りできたため、連続失敗集計は `/health` には持たせず、1 リクエストごとに独立判定 → 外形監視側で「N 回連続失敗で pager」と組む方針に倒した（isolate 跨ぎで状態を持たない素直さを優先）

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

| HTTP | Code                    | 意味                                      |
| ---- | ----------------------- | ----------------------------------------- |
| 400  | `VALIDATION_ERROR`      | Zod 検証失敗                              |
| 401  | `UNAUTHORIZED`          | 認証情報なし／不正                        |
| 403  | `FORBIDDEN`             | 権限なし（RLS 違反）                      |
| 404  | `NOT_FOUND`             | リソースなし                              |
| 409  | `CONFLICT`              | 一意制約違反                              |
| 412  | `PRECONDITION_FAILED`   | If-Match の版が不一致（楽観ロック競合）   |
| 428  | `PRECONDITION_REQUIRED` | If-Match 未指定（条件付き更新が必須）     |
| 429  | `RATE_LIMITED`          | Rate Limit 超過（`Retry-After` ヘッダ付） |
| 500  | `INTERNAL_SERVER_ERROR` | 想定外エラー                              |

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

### ハイブリッドテスト構成（2 プール分割）

`vitest.config.ts` の `projects` 機能で **`node-unit` プール（threads）と `workers` プール（`@cloudflare/vitest-pool-workers`）** を分割している。`pnpm test` 一発で両プールが順に走る。

| プール      | ランタイム           | 対象 include                                                                                                                                                                    | 速度 | 狙い                                                                                                                   |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `node-unit` | Node (threads)       | `app/modules/*/domain/**` / `app/modules/*/application/**` / `app/shared/domain/**` / `app/shared/http/**` / `logger.test.ts` / `node-pino-logger.test.ts` / `supabase.test.ts` | 速い | TDD の内ループ。純粋層を ECMAScript として高速に検証                                                                   |
| `workers`   | workerd（miniflare） | `app/modules/*/infrastructure/**` / `app/__tests__/integration/**` / `jwks-fetcher.test.ts`                                                                                     | 遅い | 本番と同じランタイムで `fetch` / Web Crypto / `caches.default` / Hono / Supabase REST を実行し、Workers 互換事故を検出 |

| 種類                   | プール      | 対象                                 | 配置                         | DB                          |
| ---------------------- | ----------- | ------------------------------------ | ---------------------------- | --------------------------- |
| 単体（domain）         | `node-unit` | Entity / VO / Repository interface   | 実装と共置                   | 不要                        |
| 単体（application）    | `node-unit` | UseCase（in-memory repo で差し替え） | 実装と共置                   | 不要                        |
| 単体（infrastructure） | `workers`   | Repository 実装                      | 実装と共置                   | 必要（Supabase ローカル）   |
| 統合                   | `workers`   | routes / controllers / 跨り系        | `app/__tests__/integration/` | UseCase mock or 実 Supabase |
| E2E                    | Bruno       | 全エンドポイント疎通                 | `bruno/`                     | 必要                        |

カバレッジ閾値: **80%**（lines / functions / branches / statements 全て）。両プール合算で計測する。未達はビルドエラー扱い。

DDD-lite ではドメイン層が DB 非依存になるため、`application/` のテストが**爆速**（in-memory 実装で差し替え可能）。

### workers プールの実装メモ

- `defineWorkersProject` で `wrangler.toml` を読ませることで、本番に近い `compatibility_date` / バインディング設定で workerd を起動する（`@cloudflare/vitest-pool-workers@0.8.x` が vitest 3.x の peer）
- `miniflare.bindings` で `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `NODE_ENV=test` / `LOG_LEVEL=error` を注入（`wrangler.toml` の `[vars]` を上書き）
- workers プールでは `process.env` が空になるため、infrastructure テストは **`cloudflare:test` から `env` を import** し `loadEnv(env)` に渡す。`loadEnv()` は引数省略時に `process.env` を読むので、両ランタイムで同じ関数を使い分けられる構造（`app/shared/http/env.ts:33`）
- `cloudflare:test` モジュールの型は `app/__tests__/cloudflare-test.d.ts` の triple-slash reference で取り込む（本番ビルドの `tsconfig.json` `types` を汚さない）

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
- [x] **Phase 8**: **Supabase Auth メール運用**（確認メールのテンプレート / Custom SMTP / 確認後リダイレクト設計）— **2026-05-14 完了**
  - 本番は `enable_confirmations = ON`（＝正しい設定）。「Supabase Auth を使うバックエンド担当」として確認メールのテンプレ更新・Custom SMTP 切替を一周しておく
  - [x] Step 1（2026-05-13 完了）: ローカルの `supabase/config.toml` を `enable_confirmations = true` にして本番に揃え、`POST /v1/customers` → 確認メール（Inbucket/Mailpit http://localhost:54324 で受信・`verify` リンク + 6 桁 OTP を確認）→ 確認リンク 303 リダイレクト + `auth.users.email_confirmed_at` セット → パスワードログインで JWT 取得、までを一周。あわせて確認必須化で顕在化したサインアップ経路の不具合を修正（確認必須だと `auth.signUp()` がセッションを返さず、直後の「トリガ生成 customers 行の読み戻し」が RLS で 404 になる → サインアップ経路の customers 参照だけ service_role の admin クライアント経由に変更）。`site_url` / `additional_redirect_urls` はフロント未稼働のため一旦 `http://127.0.0.1:3010/health` に着地（他のローカル PJT のポート 3000 と衝突させない）
  - [x] Step 2（2026-05-14 完了）: メールテンプレートをリポジトリ管理に — `supabase/templates/{confirmation,recovery,magic_link,email_change}.html` を新設（日本語＋ブランド色 `#b85c5c`・テーブルレイアウト + インライン CSS で HTML メール互換）。`supabase/config.toml` の `[auth.email.template.*]` 4 セクションを有効化し件名を `【ケーキショップ】…` に日本語化。`{{ .ConfirmationURL }}` / `{{ .Token }}` / `{{ .SiteURL }}` / `{{ .Email }}` / `{{ .NewEmail }}` / `{{ .Data }}` の使い方を冒頭コメントに整理。confirmation メールは Mailpit で実機表示を確認済（recovery / magic_link / email_change は同じ仕組みなので個別検証は省略）
  - [x] Step 3（2026-05-14 完了）: 確認後リダイレクトの三層設計（`site_url` / `additional_redirect_urls` / `redirect_to`）と PKCE/Implicit フローを整理 → [認証メールのリダイレクト設計](#認証メールのリダイレクト設計supabase-auth-phase-8-step-3) 参照。`additional_redirect_urls` に将来のフロント用 `http://127.0.0.1:3000/auth/callback` を追加（許可リスト整備）
  - [x] Step 4（2026-05-14 完了 — 方針変更）: 当初は「ローカルで `[auth.email.smtp]` を Resend に切替えて実メール送信」と定義していたが、実行段階で **ホスト Windows の Norton Antivirus "Web/Mail Shield" が outbound TLS を巻き取り、自社 CA で再署名** していたため、gotrue コンテナ → smtp.resend.com の TLS 検証が `x509: certificate signed by unknown authority` で必ず落ちることが判明（PowerShell の生 TLS で確認した Issuer = `CN=Norton Web/Mail Shield Root`）。Norton Root をコンテナ CA 束に注入する案はリポジトリの clean さを壊し、Norton の TLS スキャンを切る案は PC のセキュリティ運用を犠牲にするので不採用。**Step 5 と統合して「Cloud 上の Supabase に直接 Resend を繋ぐ」に再定義**することで Custom SMTP の学習目的は完全達成可能と判断（Cloud は Norton の手の届かない場所で動くため、Resend の正規証明書がそのまま見える）。`supabase/config.toml` の `[auth.email.smtp]` ブロックには経緯メモを残してコメントアウト状態に戻し、`.env.example` / CLAUDE.md にも同じ罠を踏まないためのメモを記録。ローカルは引き続き Inbucket（http://127.0.0.1:54324）で運用
  - [x] Step 5（2026-05-14 完了）: **Cloud 上の Supabase（production / staging）に Custom SMTP を直接設定して実メール送信** — Resend は無料枠 + ドメイン未認証で運用（自前ドメインは未取得のため `onboarding@resend.dev` を Sender にして Sender Name `ケーキショップ` でブランド感だけ確保。宛先制限は「Resend アカウント登録メール宛のみ」だが学習目的には十分）。Supabase Dashboard → Authentication → Emails の **SMTP Settings**（Host=`smtp.resend.com` / Port=587 / Username=`resend` / Password=Resend API key、staging / production で別 API key 推奨）と **Templates** タブ（Confirm sign up / Reset password / Magic link / Change email address の Subject + Body を `supabase/templates/*.html` の中身で上書き）を staging → production の順で設定。staging で `POST /v1/customers` → Gmail に「ケーキショップ <onboarding@resend.dev>」差出人・日本語テンプレで確認メール到達（DKIM 署名 `resend.dev` で Gmail スパムフィルタ通過）→ 確認リンク踏破 → URL ハッシュに JWT（`email_verified: true`）が乗って戻ってくる、まで end-to-end 確認。production も同様に SMTP / テンプレを設定したうえで、Phase 8 Step 1 のサインアップ admin client 修正を Phase 7 Step 9 で組んだ本番リリースパイプライン（`develop`→`main` PR → CI 緑 → `versions upload --env production`（0%）→ Environment `production` 承認ゲート → `versions deploy <id>@100`）で本番に流し、再度 `POST /v1/customers` で 409 CONFLICT（メール重複）が返ることを確認 = admin クライアント経由の `findByEmail` が本番で正しく動作する証拠。**罠**: Resend 無料枠の宛先制限は SMTP の `RCPT TO` 生文字列を見るため、Gmail の `+alias` トリック（例 `online384+prod@gmail.com`）は別宛先として弾かれる（`Error sending confirmation email`）。完全一致で叩く or ドメイン認証する
- [ ] **Phase 9**: **観測・運用の質を上げる**（本番運用を想定したロギング・ヘルス・メトリクス・アラート）
  - 動機: Phase 7 で Workers 互換ロガー（pino 互換 JSON 出力）の土台は整ったが、**1 リクエストで吐かれた全ログを追える / 依存サービス異常を `/health` で検知できる / エラー率急騰でアラートが飛ぶ**までは未整備。本番に出した API を運用できる状態にするための観測ハードを一周する
  - [x] Step 1（2026-05-15 完了）: **リクエスト ID 伝播 + リクエストスコープロガー** — `app/shared/http/request-context.middleware.ts` を新設。入口で `X-Request-Id` 採用（サニタイズ `/^[A-Za-z0-9_-]{1,128}$/` を通らない値はログ汚染対策で拒否）→ 無ければ `crypto.randomUUID()`（Web Crypto API、Workers / Node 22 共通）で生成。`AppVariables` に `requestId?` / `logger?` を追加 → `c.set('logger', baseLogger.child({ requestId, method, path }))` で req スコープロガーを積む。`createApp` に `globalMiddlewares` フィールドを足して `*`（`/health` 含む）に適用し、外形監視からの叩きも `requestId` 付きでログ追跡可能に。レスポンスヘッダ `X-Request-Id` に反射（クライアントが障害報告時に貼ってもらう運用）。`error-handler` は `c.get('logger') ?? fallbackLogger` 優先に切替（child binding に requestId/method/path が乗るので重複出力を削除）。`createModulesMiddleware` も同様に `c.get('logger')` を優先採用し、per-request UseCase / Repository に req スコープロガーが行き渡る。テスト 7 ケース（有効ヘッダ採用 / 未指定で自前生成 / 空白拒否 / 不許可文字拒否 / 128 文字超拒否 / child bindings 検証 / デフォルト UUID v4 形式）+ `pnpm verify` 緑（267 テスト）+ `pnpm test:coverage` 緑（middleware 100% カバー、全体閾値クリア）
  - [x] Step 2（2026-05-15 完了）: **アクセスログミドルウェア** — `app/shared/http/access-log.middleware.ts` を新設。入口で `start = Date.now()` を取り `await next()` 後に `{status, duration_ms, userId}` を req スコープロガー経由で出力（`method` / `path` / `requestId` は Step 1 の child binding に既に乗っているので二重出力しない）。ステータス別にレベルを出し分け（5xx → `error` / 4xx → `warn` / それ以外 → `info`）して、Cloudflare Logs / Datadog の `level=error` 検索で障害だけ拾える形に。`userId` は `c.get('user')?.id` を spread して**未認証時はキーごと省略**（誤って `userId: undefined` を残さない）。`bootstrap.ts` で `requestContextMiddleware` の直後に並べて `/health` 含む全パスに適用（外形監視からの叩きも duration が観測できる）。Hono 標準 `logger()` を使わない理由は「console.log にプレーンテキストで吐くため structured 検索ができない」+「req スコープロガーに乗せた `requestId` バインドを引き継げない」。`logger` が積まれていない最小テスト app 経路では no-op（fallback logger を import すると Workers バンドルに pino / 裸 console を混ぜるリスクが出るため）。テスト 6 ケース（2xx info / 4xx warn / 5xx error / 認証済 userId 出力 / 未認証で userId キーごと省略 / logger 未挿入時 no-op）+ `pnpm verify` 緑（273 テスト）+ `pnpm test:coverage` 緑（middleware 100% カバー、全体閾値クリア）
  - [x] Step 3a（2026-05-18 完了）: **`/health` の充実（骨格・仮の閾値）** — `app.ts` の `AppOptions` に `healthDbProbe?: HealthDbProbe` を追加。probe は `() => Promise<{ok, latency_ms}>` の純粋関数で、tests から fake 注入できる DI 形状。本番 probe は `bootstrap.ts` で anon Supabase client を 1 つ作って `cakes` を `select('id').limit(1).abortSignal(AbortSignal.timeout(1500))` で叩く実装（per-request ではなく cold start 時に 1 度だけ作る／RLS は public read を許可している cakes のみに依存）。/health は 3 状態 (`ok | degraded | down`) を返す: probe.ok かつ `latency_ms ≤ 800` → `ok` / probe.ok かつ `latency_ms > 800` → `degraded` / それ以外（タイムアウト・クエリエラー・接続不到達）→ `down`。HTTP ステータスは `ok`/`degraded` → 200・`down` → 503（外形監視・uptime monitor を pager に乗せるため `degraded` では緑、`down` のみ赤に倒す）。**現状の仮の閾値**: probe timeout 1500ms / degraded boundary 800ms / stateless（連続失敗カウントなし）。これらは Step 3b（任意・後日）で実測ベースに調整予定。テスト 6 ケース（既存 2: probe 省略 / appVersion 反映 + 新規 4: ok / degraded / down(タイムアウト相当) / down(クエリエラー相当)）+ `pnpm verify` 緑（277 テスト）
  - [x] Step 3b（2026-05-18 完了）: **`/health` 閾値の実測すり合わせ** — 仮置きした 3 つの判断（`DEGRADED_LATENCY_MS=800` / `PROBE_TIMEOUT_MS=1500` / stateless）を、コードを一時改変 → revert する方式で 3 シナリオ実測検証し**全て据え置きで妥当**と結論。ベースライン: 初回 cold `≈290ms` → 暖機後 `36–66ms`（800ms boundary を大きく下回る）／シナリオ 1（`DEGRADED_LATENCY_MS=5` に一時変更）で 36ms 応答が `degraded` / 200 に切替、3 状態分岐と「degraded は緑のまま」運用方針を確認／シナリオ 2（`PROBE_TIMEOUT_MS=50` に一時変更）で AbortSignal 打ち切り → `down` / 503 / `latency_ms=59ms`、タイムアウト経路がドキュメント通り動く／シナリオ 3（`supabase stop` で REST 完全停止）で `latency_ms=1518ms` ≒ `PROBE_TIMEOUT_MS=1500` の **down via timeout**。最大の学び: Docker Desktop / WSL2 経由のポートはコンテナ停止直後でも TCP SYN を即座に RST せず吸い込むため、TCP 層で「接続不到達」は観測されず**全部タイムアウト経由で down に倒れる**。`AbortSignal.timeout()` が無ければ OS デフォルトの 30–120 秒まで握る事故になる → probe timeout の存在価値が実機で証明された。詳細は [`/health` の応答仕様の Step 3b 実測体験のまとめ](#step-3b-実測体験のまとめ2026-05-18) を参照
  - [x] Step 4（2026-05-19 完了）: **メトリクス収集（Workers Analytics Engine）** — `app/shared/infrastructure/metrics.ts` で `MetricsRecorder` interface + `createAnalyticsEngineRecorder`（Workers 実書き込み）/ `createNoopMetricsRecorder`（Node・テスト・binding 未注入）を実装。`writeDataPoint` のペイロードは **blob `[method, route, status_class, env, app_version]` / doubles `[duration_ms]` / indexes `[status_class]`** の固定順。`access-log.middleware.ts` に `metrics?: AccessLogMetricsBinding` の DI を足し、`routePath(c, -1)` で正規化した route（middleware 経由の `'*'` 退避）を渡す。`wrangler.toml` は **A 案: 物理分離**（`api_requests_staging` / `api_requests_production`、binding 名 `API_REQUESTS` 共通）+ トップレベル fallback dataset。`@cloudflare/workers-types` への直接依存は避けて自前 duck typing（Phase 7 ロガー隔離と同じ方針）。**PII は入れない**（userId はアクセスログにだけ、メトリクスには載せない）。fire-and-forget で response latency に乗らない。テストは metrics.test.ts（新設 19 ケース）+ access-log.middleware.test.ts（既存 6 + 新規 4）で 300 テスト全緑。**SQL 検証は Workers Free プランで Analytics Engine SQL API が HTTP 403（書き込みは Free でも可・読み出しは Paid 必須）** のため、コード検証（300 テスト緑）+ `pnpm wrangler tail cake-shop-api-staging` で本番アクセスログ（`level=30` 2xx / `level=40` 4xx、`requestId` / `path` / `status` / `duration_ms`）が**本番経路で吐かれていること**を実機目視確認してクローズ。route 正規化の最終形（`/v1/orders/:id` 集約）の SQL 確認は Paid 移行時のフォローアップに繰越（※当初ここに「Step 5 で Logpush + R2 + DuckDB に倒せば Free のまま SQL 体験を取り戻せる可能性あり」と書いていたが、**Step 5 で裏取りした結果 Logpush は Workers Paid 必須で Free では使えない**ことが判明。この見込みは誤りだったため取り消す）。**⚠️ デプロイ事故の訂正（2026-05-20）**: この AE バインディング追加（`[[analytics_engine_datasets]]`）以降、**Cloudflare アカウント側で Analytics Engine が未有効**だったため `deploy-staging.yml` が **error 10089（`You need to enable Analytics Engine`）でずっと失敗していた**（Step 4 直後の暫定クローズを `wrangler deploy --dry-run`〔API 非接続〕+ 旧デプロイへの `wrangler tail` で済ませたため、CI 実デプロイが通っていないことを見逃した）。修正は **Cloudflare Dashboard → Workers & Pages → Analytics Engine で dataset を作成する＝アカウントの AE 有効化**（この操作自体は **Free プランで可能**）→ 失敗 run を再実行で復旧。**AE のナビ / dataset 作成は Free でも表示・操作でき、Paid 必須は SQL 読み出しだけ**。教訓: アカウント有効化を伴う変更を入れたら dry-run でなく **CI 実デプロイの成否を必ず確認**してからクローズする
  - [x] Step 5（2026-05-20 完了 — Free プラン制約下で再定義してクローズ）: **観測・アラート** — 当初は「Logpush で R2 / 外部 SaaS へ送出 + Notifications で Slack」を想定したが、課金境界を裏取りした結果 **Free では送出・通知の主要経路がほぼ Paid 境界の外**（Logpush=Workers Paid 必須 / webhook=Pro 以上 / メール通知=Free だが種別限定）と判明。Step 4 と同じく Free 枠内に再定義した。実装は `wrangler.toml` の `[observability]` を3スコープとも明示化（`head_sampling_rate = 1` を追記し、日次上限に当たったら絞る判断材料を Why コメントで残す。Workers Logs 自体は以前から有効）。観測体験は「わざと 5xx を出してアラートが飛ぶ」が Free 不可（5xx 率アラートは Notifications の Free 種別に無い）ため **「わざと 5xx を出して Workers Logs から requestId / status / route で追う」に置換**し、Step 1/2 で仕込んだ構造化フィールドをここで回収。詳細は [Phase 9 Step 5 — Free 枠の観測・アラート](#phase-9-step-5--free-枠の観測アラート) 参照。Logpush 送出 / 5xx 率アラート / Slack 連携 / Step 4 の SQL 検証は Workers Paid 移行時の繰越
- [x] **Phase 10**: **API のリッチ化**（実運用 REST API でよく出てくる設計パターンを縦切りで実演）— **Step 1〜7 全完了（2026-05-20〜05-26）**
  - 動機: 現状の cakes/customers/orders は MVP 規模。実運用なら必須レベルの「ページネーション / ソート / 検索 / 楽観ロック / Rate Limit / Idempotency-Key / Webhook」を**設計判断の練習場**として一周する。それぞれ単独機能というより「設計上のトレードオフを言語化する素材」として扱う
  - [x] Step 1（2026-05-20 完了）: **ページネーション（`/v1/cakes`）** — cursor-based（keyset）を採用。`?limit=20&after=<opaque-cursor>` 形式で、`Link` ヘッダ（RFC 5988, `rel="next"`）とレスポンスボディ `next_cursor` / `has_more` を両論併記。カーソルは `(name, id)` 複合キー（`name` 非一意のため境界またぎ耐性が要る）を base64url で包んだ不透明トークンにし、`TextEncoder`/`TextDecoder` で UTF-8 安全化（`btoa`/`atob` の Latin1 制約と Workers の `Buffer` 不在を回避）。改竄カーソルは Zod 検証で `400 VALIDATION_ERROR`。汎用コーデックを `app/shared/http/cursor.ts` に切り出し。詳細仕様は「[`GET /v1/cakes` のページネーション仕様](#get-v1cakes-のページネーション仕様phase-10-step-1)」参照
  - [x] Step 1.5（2026-05-20 完了）: **ページネーション（`/v1/orders`）** — orders は一覧エンドポイントが未実装だったため、RLS 保護付き `GET /v1/orders`（本人の注文のみ）を新設し、Step 1 の cursor codec（`app/shared/http/cursor.ts`）を再利用。カーソルは `(placed_at, id)` 複合キー（同時刻の注文がありうる非一意キーのため id を tiebreaker に複合化）で、新しい順（`placed_at DESC, id DESC`）に並べる。本人フィルタは **多重防御**（RLS の `orders_select_self` + repository の明示 `customer_id` 絞り込み）で、`service_role` 経路でも漏れない設計。`PostgREST` の `.or('placed_at.lt."X",and(placed_at.eq."X",id.lt."Y")')` でキーセット前進。詳細仕様は「[`GET /v1/orders` のページネーション仕様](#get-v1orders-のページネーション仕様phase-10-step-15)」参照
  - [x] Step 2（2026-05-21 完了）: **ソート・フィルタ（`/v1/cakes`）** — `?sort=-price,name` 書式（`-` 降順・カンマ区切り多段、許可: name/price/stock、既定 name 昇順）を汎用パーサ `app/shared/http/sort.ts` に切り出し（`cursor.ts` と同じ「shared/http の純粋ユーティリティ」方針）。フィルタは `available`（在庫有無）/ `min_price` / `max_price`（閉区間・`min>max` は `400`）/ `q`（name 部分一致 ILIKE）。**キーセットを多段ソートに一般化**（`(sortField1..N, id)` 複合キー、`id` を常に最終 tiebreaker にして全順序を保証）し、PostgREST `.or()` の OR 展開（`(c1 OP v1) OR (c1=v1 AND c2 OP v2) OR …`）でページ前進。**カーソルに正規化 sort 文字列を埋め込み**、次ページ取得時に sort が一致しなければ `400`（フィルタは不透明トークンに含めず、絞り込みの責務はクライアント側）。詳細仕様は「[`GET /v1/cakes` のソート・フィルタ仕様](#get-v1cakes-のソートフィルタ仕様phase-10-step-2)」参照
  - [x] Step 3（2026-05-21 完了）: **検索（`/v1/cakes`）** — `q` を `ILIKE` 部分一致から **PGroonga 全文検索**に置換。日本語のケーキ名を 2 文字クエリ・ひらがな部分一致でも拾えるようにし、Step 1/2 のソート・キーセットページネーションは維持（あいまい検索＋キーセット、関連度ランキングはしない）。`pg_trgm`（3 文字トライグラム最小・苺/いちご別扱い）/ 標準 `tsvector`（日本語をトークン分割できない）の弱点を言語化したうえで PGroonga を採用。PostgREST は PGroonga 演算子 `&@` を直接呼べないため `place_order` と同じく RPC（`search_cakes` 関数 = `supabase/migrations/0005_cakes_pgroonga_search.sql`）に閉じ込め、検索 + フィルタ + 多段ソート + キーセットを動的 SQL（`%I` 識別子ホワイトリスト + `%L` 値で injection 防止）で処理。repository は `nameSearch` 有無で RPC / 従来 PostgREST を分岐。in-memory は部分一致で近似し、実 DB 挙動（2 文字「抹茶」・ひらがな「いちご」）は workers プールの実 Supabase テストで担保。詳細仕様は「[`GET /v1/cakes` のあいまい検索仕様](#get-v1cakes-のあいまい検索仕様phase-10-step-3)」参照
  - [x] Step 4（2026-05-22 完了）: **楽観ロック** — `ETag` + `If-Match` で更新競合検知。Cake の在庫更新（`PATCH /v1/cakes/:id`・stock 絶対値で冪等）に導入し、`GET /v1/cakes/:id`（ETag 取得用・認証不要）を新設。版は `cakes.version` 整数カラム + `BEFORE UPDATE` トリガ採番（`supabase/migrations/0006_cakes_optimistic_lock.sql`）で、`UPDATE … WHERE id=? AND version=?` の原子的更新により lost update を防ぐ。当初案の `409 CONFLICT` ではなく **RFC 準拠の 412 PRECONDITION_FAILED（版不一致）/ 428 PRECONDITION_REQUIRED（If-Match 欠落）** を採用（428 で無条件上書きを構造的に禁止）。Weak ETag（`W/"<version>"`）コーデックは `app/shared/http/etag.ts`。in-memory は version+1 でトリガを模し、実 DB の競合挙動は workers プールの実 Supabase テストで担保（409 テスト全緑）。詳細仕様は「[`GET /v1/cakes/:id` + `PATCH /v1/cakes/:id` の楽観ロック仕様](#get-v1cakesid--patch-v1cakesid-の楽観ロック仕様phase-10-step-4)」参照
  - [x] Step 5（2026-05-24 完了）: **Rate Limit** — Cloudflare Workers の `[[ratelimits]]` binding を 3 本（`LIMITER_PUBLIC_READ` 100/10s・`LIMITER_PUBLIC_WRITE` 5/60s・`LIMITER_AUTH_WRITE` 10/10s）に分割し、IP キー（公開系）/ user キー（認証系）で使い分け。binding の `limit()` は `{ success }` しか返さないので middleware factory が wrangler.toml の period から `Retry-After` を焼き込む。Hono の `router.use(path, mw)` がメソッドを区別しない弱点は `restrictToMethods` ヘルパで補い、`GET /` / `POST /` で `/` を共有する `cakes` / `customers` でもメソッド別 limiter を割り当てた。超過は **429 RATE_LIMITED + Retry-After ヘッダ** を返し、`details[0].field='Retry-After'` にも同値を載せる（JSON だけ読むクライアントでも秒数が取れる）。テストは node-unit プールで `InMemoryRateLimiter`（固定ウィンドウ + `now()` 差し替え）による middleware 単体 + 統合テストで「公開 GET が枯れても POST には影響しない」（`restrictToMethods` の効果）を検証、`pnpm verify` 緑（426 テスト）。詳細仕様は「[`/v1/*` の Rate Limit 仕様](#v1-の-rate-limit-仕様phase-10-step-5)」参照
  - [x] Step 6（2026-05-25 完了）: **Idempotency-Key** — 全 POST エンドポイント（`/v1/orders`・`/v1/cakes`・`/v1/customers`）で `Idempotency-Key` ヘッダ必須化（Stripe スタイル）、Postgres 永続化で再送による二重作成を防ぐ。新規テーブル `idempotency_keys`（migration `0007_idempotency_keys.sql`・複合主キー `(key, owner_type, owner_id, scope)` + `request_hash` + `status` + `response_status/body` + `expires_at(default now()+24h)`、RLS 明示ポリシー無し = service_role 専用）。`IdempotencyStore` ポート（`app/shared/infrastructure/idempotency-store.ts`）は 4 状態 union（`inserted`/`replay`/`in_progress`/`mismatch`）を返す `tryReserve` + `complete` の 2 メソッドで、Supabase 実装は PostgREST の `.upsert(..., { ignoreDuplicates: true, onConflict: 'key,owner_type,owner_id,scope' })` で `INSERT … ON CONFLICT DO NOTHING` 相当を達成。middleware（`app/shared/http/idempotency.middleware.ts`）は **canonical JSON**（キー sort）+ Web Crypto SHA-256 で body をハッシュ化し、replay 経路では `c.newResponse(JSON.stringify(body), status)` で再現 + `Idempotency-Replayed: true` ヘッダ。owner は orders/cakes が user.id・customers は cf-connecting-ip。挿入順は `rate-limit → auth/admin → idempotency` で、認証未通過は 401/403 が先に出て store を消費しない。失敗は **400 `IDEMPOTENCY_KEY_REQUIRED`（欠落 / 形式不正）/ 409 `IDEMPOTENCY_IN_PROGRESS`（処理中）/ 422 `IDEMPOTENCY_KEY_REUSED`（同 key・違う body）**。詳細仕様は「[`POST /v1/*` の Idempotency-Key 仕様](#post-v1-の-idempotency-key-仕様phase-10-step-6)」参照
  - [x] Step 7（2026-05-26 完了）: **Webhook 配信** — 「注文確定」ドメインイベント (`order.placed`) を登録済みの外部 URL に POST。**HMAC-SHA256 署名（Stripe スタイル `t=<unix>,v1=<hex>`、Web Crypto で実装し Workers 互換）** + **指数バックオフ retry（1m → 5m → 30m → 4h → 24h → 6 回目で `dead`）**。`webhook_subscriptions` / `webhook_deliveries`（migration `0008_webhooks.sql`、`UNIQUE (event_id, subscription_id)` で event × subscription の二重発火を構造的に阻止、`webhook_deliveries.payload` で発火時 snapshot 固定）。**Cron Triggers 未使用 = リクエスト駆動の dispatch ミドルウェア**（`c.executionCtx.waitUntil(dispatchPendingDeliveries({limit:5}))`）で「トラフィックがある限り retry が進む」設計（Workers Free プランのコスト最小化）。`EventPublisher` 抽象は `app/shared/application/event-publisher.ts` に置き、`orders/place-order.usecase` から **publish 失敗を try/catch で握って warn ログ**にする（副系の失敗が注文確定を巻き戻さない）。webhooks コンテンツは `app/modules/webhooks/{domain,application,infrastructure,presentation}` に DDD-lite 4 層で完結、管理 API は **admin 専用 + Idempotency-Key 必須**（POST のみ・GET 系は対象外）。RLS は service_role 専用（明示ポリシーなし）。`seed.sql` には subscription を入れない = 公開リポジトリをそのまま叩いても外部 URL に意図せず HTTP を打たない。テスト 518 件全緑（HMAC・dispatcher の 2xx/3xx/4xx/5xx/timeout/network エラー・EventPublisher の部分失敗耐性・dispatchPendingDeliveries の状態遷移＋ dead 化・cascade 削除・サブスクリプション CRUD 4 ユースケース）。詳細仕様は「[`POST /v1/orders` → Webhook 配信仕様](#post-v1orders--webhook-配信仕様phase-10-step-7)」参照
- [ ] **Phase 11**: **レビュー機能**（ケーキ / 店舗のレビュー投稿・一覧・集計・モデレーション）— 進行中
  - 動機: Cake Shop API は MVP として CRUD + 注文系を一周したので、**ユーザー生成コンテンツ (UGC) の設計判断**を一周する。投稿資格・購入済みバッジ・モデレーション・役立った投票・通報といった、実運用のレビュー機能で必ず出てくる選択肢を縦切りで実演する
  - [x] Step 1（2026-05-27 完了）: **ケーキレビュー（投稿・一覧・集計）** — `app/modules/reviews/{domain,application,infrastructure,presentation}` を DDD-lite 4 層で新設し、`/v1/cakes/:cake_id/reviews` の GET（公開・カーソル + 集計同梱）/ POST（認証 + Idempotency-Key 必須）を実装。**投稿資格は「誰でも」**（購入してなくても投稿可）、**購入済みバッジ `is_verified_purchaser` は投稿時点の snapshot**（後で履歴が変わっても表示が動かない）として保存する設計を採用。レビュー対象は cake と店舗の二層を想定したが、Step 1 では cake 向けのみ縦切りで完成（店舗は Step 2 で同型を増殖）。スキーマは `supabase/migrations/0009_reviews.sql`（`reviews` + `UNIQUE(cake_id, user_id) WHERE status='published'` で「同一 user × cake = 1 件」を構造的に保証 + `helpful_count` カラム + 部分インデックス）+ `has_purchased(cake_id uuid, user_id uuid)` RPC（service_role からの購入済み判定。注文確定済み = orders.status='placed' の order_items 行で判定し、Step 3 の役立った投票で再利用予定）。port + adapter = `VerifiedPurchaserChecker`（`app/modules/reviews/domain/verified-purchaser-checker.ts`）の interface を切り、infrastructure 側で `SupabaseVerifiedPurchaserChecker` が RPC を 1 リクエストで叩く（in-memory 実装はテストで購入履歴を差し替え可能）。**カーソル**は sort 種別ごとに違う複合キー（`newest` = `(created_at DESC, id DESC)` / `helpful` = `(helpful_count DESC, created_at DESC, id DESC)`）+ Step 1/2 と同じ汎用 codec（base64url + sort 文字列を埋め込み・不一致 400）。集計は `count` / `average`（0 件は null）/ `distribution`（1..5 の星別件数、0 件の星も 0 を返す）を 1 レスポンスで返す（N+1 にならないよう repository 側で同じ where 句を使い回す）。**コンテキスト跨ぎ禁止対応** = `cakes` / `orders` を直接 import せず、`CakeId` は reviews ローカル VO（`app/modules/reviews/domain/cake-id.vo.ts`）として再宣言、`has_purchased` の判定だけを port 経由で受ける（cake / order の Entity は触らない）。**ルーターマウント** = cakeRouter と同じ `/v1/cakes` プレフィックスに `createReviewRouter()` を別ルーターとして並べて装着（Hono の trie は `:id` と `:cake_id/reviews` を別パスとして区別するので衝突しない）+ GET / POST が同パスを共有するので `restrictToMethods` ヘルパで authGuard / Idempotency をメソッド別ゲート。**エラー** = `409 REVIEW_CONFLICT`（同 user × 同 cake で既存）/ `400 VALIDATION_ERROR`（rating 1〜5 範囲外・title/body 空・cake_id 非 UUID・カーソル改竄 / sort 不一致）/ `401`（POST 未認証）/ `422 IDEMPOTENCY_KEY_REUSED`（同 key + 違う body）。テスト 592 件全緑（domain 単体・application UseCase・infrastructure（workers プールで実 Supabase + RPC）・presentation routes・統合 20 件 = GET 空 / フィルタ / 集計 / sort=newest / sort=helpful / verified_only / cursor 前進 + sort 不一致 400 + 改竄 400 / POST 201 + is_verified_purchaser snapshot / 409 / 401 / 422 / router 共存）+ `pnpm verify` 緑
  - [x] Step 2（2026-05-29 完了）: **店舗レビュー（単一店舗・投稿・一覧・集計）** — `reviews` コンテキスト内に `ShopReview` を **別 Aggregate / 別テーブル**として追加し、`/v1/shop/reviews` の GET（公開・カーソル + 集計同梱）/ POST（認証 + Idempotency-Key 必須）を実装。Step 1（ケーキレビュー）には一切手を入れず同型を増殖。本プロジェクトは **単一店舗**前提のため `shop_id` も `cake_id` も持たせず、テーブル `shop_reviews` / エンドポイント `/v1/shop/reviews` は店舗を 1 つだけ表す（多店舗化は破壊的変更を伴う別 Phase 判断＝ YAGNI）。利用実績バッジは **`is_verified_customer`（任意ケーキの `PLACED` 注文が 1 件でもあるか）** を投稿時点の snapshot で固定（Step 1 の `is_verified_purchaser` と同思想だが粒度が「この店で買ったことがあるか」）。スキーマは `supabase/migrations/0010_shop_reviews.sql`（`shop_reviews` + `UNIQUE(user_id) WHERE status <> 'removed'` で「1 ユーザー 1 店舗レビュー」を構造的に保証〔`removed` 行は対象外＝削除後の再投稿可〕 + 並び順用部分インデックス + `shop_review_stats()` jsonb 集計 RPC + `has_ordered(p_auth_user_id uuid)` RPC〔`security invoker`・`orders.status='PLACED'` を `customers` 経由で `auth.users.id` に紐付け〕 + RLS service_role 専用）。**port + adapter** = `OrderHistoryChecker` の interface を切り、infrastructure 側 `SupabaseOrderHistoryChecker` が `has_ordered` RPC を叩く（in-memory 実装はテストで注文履歴を差し替え可能）。**コンテキスト跨ぎ禁止対応** = Step 1 同様 `orders` の Entity は import せず、注文実績判定だけを port 経由で受ける。**ルーターマウント** = `/v1/shop` プレフィックスの独立ルーターとしてマウント（cakeRouter / reviewsRouter とパスが重ならず衝突なし）+ GET / POST が `/reviews` を共有するので `restrictToMethods` で authGuard / Idempotency を POST だけにゲート。**エラー** = `409 CONFLICT`（同 user で既存）/ `400 VALIDATION_ERROR`（rating 1〜5 範囲外・title/body 空・カーソル改竄 / sort 不一致）/ `401`（POST 未認証）/ `422 IDEMPOTENCY_KEY_REUSED`（同 key + 違う body）。テスト 678 件全緑（domain 単体・application UseCase・infrastructure（workers プールで実 Supabase + `has_ordered` / `shop_review_stats` RPC）・統合 = GET 空 / published のみ / 集計 / sort=newest / sort=helpful / verified_only / filter_rating / cursor 前進 + sort 不一致 400 + 改竄 400 / POST 201 + is_verified_customer snapshot + レスポンスに cake_id 不在 / 409 / 401 / 422 / ケーキレビューと相互非干渉）+ `pnpm verify` 緑。詳細仕様は「[`GET /v1/shop/reviews` + `POST /v1/shop/reviews` の店舗レビュー仕様](#get-v1shopreviews--post-v1shopreviews-の店舗レビュー仕様phase-11-step-2)」参照
  - [x] Step 3（2026-06-01 完了）: **「役立った」投票（ケーキ + 店舗の両方）** — レビューに対する `helpful` トグル API を **ケーキ / 店舗の両層に同型で**追加。`POST /v1/cakes/:cake_id/reviews/:review_id/helpful`（付与）/ `DELETE …/helpful`（取消）と `POST /v1/shop/reviews/:review_id/helpful` / `DELETE …/helpful` の 4 本。**投票は構造的に冪等**（`UNIQUE(user_id, review_id)` + INSERT ON CONFLICT DO NOTHING / DELETE no-op）なので **`Idempotency-Key` ヘッダは不要**（認証 + `LIMITER_AUTH_WRITE` のみ）。**自己投票は POST のみ 403 FORBIDDEN**（`review.userId === voter`）= 取消（DELETE）には自己 vote 検査を入れない（クリーンアップ用に逃げ道を残す）。スキーマは `supabase/migrations/0011_review_helpful_votes.sql`（`review_helpful_votes` / `shop_review_helpful_votes` の 2 テーブル + 親テーブル `reviews` / `shop_reviews` の `helpful_count` を **SECURITY DEFINER の AFTER INSERT/DELETE トリガ**で同期 + RLS service_role 専用 + `published` 親レビューにのみ FK を効かせる部分制約）。**port + adapter** = `ReviewHelpfulVoteRepository` / `ShopReviewHelpfulVoteRepository` の interface を切り、Supabase 実装と in-memory 実装の二系統。**コンテキスト跨ぎ禁止対応** = 投票テーブルは reviews コンテキスト内に閉じ、Review / ShopReview Entity は別ファイルのまま。**ルーターマウント** = vote パス `'/:cake_id/reviews/:review_id/helpful'` / `'/reviews/:review_id/helpful'` は reviews パスとは別 trie ノードのため上位 middleware は波及しない（cake では Step 1 の authGuard + Idempotency が reviews パスに貼られているが、vote パスには独立に authGuard + authWrite のみ貼る）。**Result 型** = `HelpfulVoteResult = { helpfulCount: number; voted: boolean }`（応答も `{ review_id, helpful_count, voted }` 同形）。**エラー** = `200 OK`（成功 / 再 POST no-op / 未投票 DELETE no-op）/ `400 VALIDATION_ERROR`（review_id 非 UUID）/ `401`（未認証）/ `403 FORBIDDEN`（POST 時に自分のレビュー）/ `404 NOT_FOUND`（対象レビューが存在しない / published でない）。テスト 729 件全緑（domain 拡張・application UseCase 4 本（cake/shop × vote/remove）・infrastructure（workers プールで実 Supabase + SECURITY DEFINER トリガで `helpful_count` が同期されること）・統合 = POST 200/voted・再 POST no-op・自己 vote 403・DELETE 200/voted=false・未投票 DELETE no-op・401・404・400・ケーキと店舗の相互非干渉）+ `pnpm verify` 緑（coverage statements 84.33% / branches 74.53%）

---

## 開発ワークフロー

このプロジェクトは **[Claude Code](https://claude.com/claude-code) 主導で開発** しています。

- 規約・禁止パターン・実装手順は [`CLAUDE.md`](./CLAUDE.md) に集約
- フェーズごとに「設計判断」「ハマりやすい落とし穴」を学習サマリーとして蓄積
- TDD（RED → GREEN → REFACTOR）を厳守

---

## ライセンス

[MIT License](./LICENSE)
