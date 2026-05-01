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

## 主な特徴

- **DDD-lite アーキテクチャ**: Bounded Context（`cakes` / `customers` / `orders`）× 4 層（`domain` / `application` / `infrastructure` / `presentation`）。依存方向を内向き一方向に固定し、ドメイン層を DB 非依存に保つ
- **Repository + UseCase パターン**: domain で interface を定義、infrastructure で Supabase 実装。UseCase は in-memory repo で爆速テスト
- **API バージョニング**: 全業務エンドポイントを `/v1` 配下に配置（`/health` のみ非バージョン）
- **型安全な API 設計**: `@hono/zod-openapi` で Zod スキーマから OpenAPI 仕様を自動生成（仕様の二重管理ゼロ）
- **構造化ログ**: pino による JSON ログ。障害対応・QA 対応ができるレベルで `method` / `path` / `requestId` 等を残す
- **統一エラーレスポンス**: `code` / `message` / `details` 形式で、クライアントがプログラム的にエラー種別を分岐可能
- **fail-fast な env 検証**: 起動時に Zod で `process.env` を検証
- **Supabase Auth + RLS**: JWT 認証ミドルウェア + Row Level Security でテーブル単位のアクセス制御
- **TDD 必須**: Vitest によるカバレッジ 80% 強制（未達はビルドエラー）。テストは実装と共置
- **再現性ある開発環境**: fnm で Node 固定、corepack で pnpm 固定、Supabase CLI でローカル DB 完結

---

## 技術スタック

| カテゴリ | 採用 | 選定理由 |
|---|---|---|
| Runtime | Node.js 22 LTS | Active LTS。安定性とモダン機能の両立 |
| Framework | [Hono](https://hono.dev/) 4.x | 軽量・高速・型安全。Edge / Node 両対応 |
| OpenAPI | [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) | コードと仕様の二重管理を回避 |
| Validation | [Zod](https://zod.dev/) | TypeScript ネイティブのスキーマ検証 |
| Database | Supabase (PostgreSQL 15) | Auth / RLS / リアルタイムまで含む BaaS |
| Logger | [pino](https://getpino.io/) | 構造化 JSON、本番運用標準 |
| Test | [Vitest](https://vitest.dev/) | Vite ベース、ESM ネイティブ、高速 |
| Package Manager | pnpm 9.15.0 (via corepack) | ディスク効率・モノレポ対応・速度 |
| Container | Docker Compose（アプリのみ）+ Supabase CLI（DB） | 役割を明確に分離 |

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

---

## 主要コマンド

| コマンド | 用途 |
|---|---|
| `pnpm dev` | 開発サーバー起動（tsx watch） |
| `pnpm build` | 本番ビルド（tsup） |
| `pnpm start` | ビルド済みアプリの起動 |
| `pnpm test` | テスト実行 |
| `pnpm test:coverage` | カバレッジ計測（閾値 80%） |
| `pnpm typecheck` | TypeScript 型チェック |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `supabase start` / `stop` | ローカル Supabase の起動 / 停止 |
| `supabase db push` | マイグレーション適用 |

---

## ディレクトリ構成（DDD-lite）

```
.
├── app/
│   ├── index.ts                                  # エントリーポイント
│   ├── app.ts                                    # Hono インスタンス・ルート集約
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
│   │   ├── infrastructure/                       # logger / Supabase クライアント
│   │   └── http/                                 # env 検証 / error-handler
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

---

## API 設計

### バージョニング

- 業務エンドポイントは **`/v1` 配下に配置**
- 非バージョンに置けるのは `/health` のみ
- 破壊的変更時は `/v2` を新設し、`/v1` は維持

### エンドポイント

| Method | Path | 認証 | 概要 |
|---|---|---|---|
| GET | `/health` | 不要 | ヘルスチェック |
| GET | `/v1/cakes` | 不要 | ケーキ一覧 |
| POST | `/v1/cakes` | 管理者 | ケーキ登録 |
| POST | `/v1/customers` | 不要 | 顧客サインアップ |
| GET | `/v1/customers` | 管理者 | 顧客一覧 |
| POST | `/v1/orders` | 必須 | 注文作成 |
| GET | `/v1/orders/:id` | 本人 | 注文詳細 |

### 統一エラーレスポンス

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "リクエストパラメータが不正です",
    "details": [
      { "field": "price", "message": "0より大きい整数を指定してください" }
    ]
  }
}
```

| HTTP | Code | 意味 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod 検証失敗 |
| 401 | `UNAUTHORIZED` | 認証情報なし／不正 |
| 403 | `FORBIDDEN` | 権限なし（RLS 違反） |
| 404 | `NOT_FOUND` | リソースなし |
| 409 | `CONFLICT` | 一意制約違反 |
| 500 | `INTERNAL_SERVER_ERROR` | 想定外エラー |

---

## テスト方針

| 種類 | ツール | 対象 | 配置 | DB |
|---|---|---|---|---|
| 単体（domain） | Vitest | Entity / VO / Repository interface | 実装と共置 | 不要 |
| 単体（application） | Vitest | UseCase（in-memory repo で差し替え） | 実装と共置 | 不要 |
| 単体（infrastructure） | Vitest | Repository 実装 | 実装と共置 | 必要（Supabase ローカル） |
| 統合 | Vitest + Hono `app.request()` | routes / controllers / 跨り系 | `app/__tests__/integration/` | UseCase mock or 実 Supabase |
| E2E | Bruno | 全エンドポイント疎通 | `bruno/` | 必要 |

カバレッジ閾値: **80%**（lines / functions / branches / statements 全て）。未達はビルドエラー扱い。

DDD-lite ではドメイン層が DB 非依存になるため、`application/` のテストが**爆速**（in-memory 実装で差し替え可能）。

---

## 実装進捗

- [x] **Phase 1**: 設定ファイル群・プロジェクト初期化
- [x] **Phase 2**: Hono アプリ骨格 + `/health` + 統一エラー形式 + 構造化ログ + env 検証
- [x] **Phase 2.5**: DDD-lite 4 層構造への移行（`shared/` 共有カーネル + `modules/{cakes,customers,orders}/` 骨格）
- [ ] **Phase 3**: `cakes` Bounded Context（domain → application → infrastructure → presentation 縦切り完成）
- [ ] **Phase 4**: `customers` Bounded Context（同構造）
- [ ] **Phase 5**: `orders` Bounded Context（Domain Event + Postgres Function でアトミック在庫減算）
- [ ] **Phase 6**: Supabase Auth + RLS + 認証ミドルウェア + OpenAPI 仕上げ

---

## 開発ワークフロー

このプロジェクトは **[Claude Code](https://claude.com/claude-code) 主導で開発** しています。

- 規約・禁止パターン・実装手順は [`CLAUDE.md`](./CLAUDE.md) に集約
- フェーズごとに「設計判断」「ハマりやすい落とし穴」を学習サマリーとして蓄積
- TDD（RED → GREEN → REFACTOR）を厳守

---

## ライセンス

[MIT License](./LICENSE)
