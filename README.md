# Cake Shop Order API

Hono × Supabase × TypeScript で構築する、実務志向の軽量 REST API サンプル。

[![Node.js](https://img.shields.io/badge/Node.js-22_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-Latest-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 学習用サンプルですが、**実運用で困らないレベル** を意識して設計しています。
> **DDD-lite（モジュラモノリス × 4 層構造）** を採用し、API バージョニング、構造化ログ、Zod による型安全な入出力、Supabase Auth + RLS、OpenAPI 自動生成、TDD まで一通り実装します。

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
# => {"status":"ok"}

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

### 本番（Cloudflare Workers）

```bash
# 初回のみ: Cloudflare アカウント作成 + ログイン
pnpm wrangler login

# 本番 secret 登録（3 回実行）
pnpm wrangler secret put SUPABASE_URL
pnpm wrangler secret put SUPABASE_ANON_KEY
pnpm wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# デプロイ
pnpm wrangler:deploy

# ログ確認（リアルタイム tail）
pnpm wrangler:tail
```

---

## 主要コマンド

| コマンド                    | 用途                                                  |
| --------------------------- | ----------------------------------------------------- |
| `pnpm dev`                  | 開発サーバー起動（Node / tsx watch）                  |
| `pnpm build`                | 本番ビルド（tsup）                                    |
| `pnpm start`                | ビルド済みアプリの起動（Node）                        |
| `pnpm test`                 | テスト実行                                            |
| `pnpm test:coverage`        | カバレッジ計測（閾値 80%）                            |
| `pnpm typecheck`            | TypeScript 型チェック                                 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                     |
| `pnpm wrangler:dev`         | **Workers ローカル実行**（V8 Isolate を再現）         |
| `pnpm wrangler:deploy`      | **Cloudflare Workers へ本番デプロイ**                 |
| `pnpm wrangler:tail`        | 本番 Workers のログをリアルタイムで tail              |
| `supabase start` / `stop`   | ローカル Supabase の起動 / 停止                       |
| `supabase db push`          | マイグレーション適用（リンク済みプロジェクトに対し）  |

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
- [ ] **Phase 7**: **Cloudflare Workers 化**（本番デプロイ想定の最終段）
  - [x] Step 1〜6: エントリ二系統化 / `wrangler.toml` / `.dev.vars` / Workers 互換ロガー / JWKS DI / Workers ローカル疎通
  - [x] Step 7: 初回本番デプロイ完了（Cloudflare アカウント取得 + Supabase Cloud 連携 + secret 登録 + `wrangler deploy`。`https://cake-shop-api.<account>.workers.dev/health` / `/v1/cakes` 200 OK 確認済み）
  - [ ] Step 8: 環境分離（`[env.staging]` / `[env.production]` + 各 env 用 secret）
  - [ ] Step 9: GitHub Actions（`cloudflare/wrangler-action@v3`）で自動デプロイ + Versioned Deployments

---

## 開発ワークフロー

このプロジェクトは **[Claude Code](https://claude.com/claude-code) 主導で開発** しています。

- 規約・禁止パターン・実装手順は [`CLAUDE.md`](./CLAUDE.md) に集約
- フェーズごとに「設計判断」「ハマりやすい落とし穴」を学習サマリーとして蓄積
- TDD（RED → GREEN → REFACTOR）を厳守

---

## ライセンス

[MIT License](./LICENSE)
