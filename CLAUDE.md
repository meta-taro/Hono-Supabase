# CLAUDE.md — Cake Shop Order API

このファイルは Claude Code（AIエージェント）向けのプロジェクト指示書です。
新しいマシン・セッションでもこのファイルを読めば即座に開発を再開できます。

---

## Project Overview

**目的**: Hono × Supabase を使った実務レベルの軽量バックエンド API を構築する学習サンプル
**ドメイン**: ケーキ屋の商品・顧客・注文管理
**採用アーキテクチャ**: **DDD-lite（モジュラモノリス × 4層構造）**

### 想定利用シーン

- **典型構成**: Next.js（Vercel）等のフロントエンドから JWT (Supabase Auth) で本 API を呼び出す **バックエンド API 単体**
- **認証方式**: Supabase Auth が発行する JWT を `Authorization: Bearer <token>` で受け取るステートレス方式（Phase 6 で実装）
- **本番デプロイ先**: **Cloudflare Workers**（V8 Isolate 上のグローバルエッジ実行）。Hono が Web 標準ベースで Workers ネイティブに動くため、`@hono/node-server` を使わずに `export default app` 形式で展開する
- **ローカル開発ランタイム**: Node.js 22 LTS。学習中の TDD・デバッグ・型チェックは Node 上で完結させ、本番経路だけ Workers に切り替える二段構え
- **データ層**: Supabase（PostgreSQL）は **Cloudflare Workers から Supabase REST API（`@supabase/supabase-js`）経由で接続**。TCP 直接続不可な Workers 環境でもそのまま動く（PostgreSQL 直接続が必要になったら Cloudflare Hyperdrive を後付け検討）
- **スコープ外**: フロントエンド実装・専用 SDK・IaC（フロントは別リポジトリで Next.js 想定）

### 学習ゴール

- DDD-lite による境界づけられたコンテキスト・レイヤ分離・依存方向の制御
- API バージョニング設計（`/v1` プレフィックス）
- `@hono/zod-openapi` による型安全な API 設計と OpenAPI 仕様の自動生成
- Supabase Auth + RLS（Row Level Security）によるアクセス制御
- Supabase Auth のメール運用（確認メールのテンプレートカスタマイズ・Custom SMTP への切替・確認後リダイレクト設計・ローカルは Inbucket で観察）
- 構造化ログ（**Workers 互換ロガー** + Node ローカル時の pino-pretty 切替）
- Vitest を使った TDD（テスト駆動開発）
- Docker + Supabase CLI による再現性ある開発環境
- **Cloudflare Workers ネイティブ動作のための制約理解**（`fs` / `child_process` 等の Node 専用 API を使わない、ロガーは Workers 互換、cold start を意識した依存最小化）

---

## Tech Stack（決定済み）

| カテゴリ                      | 技術                                                                       | バージョン | 選定理由                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本番ランタイム**            | **Cloudflare Workers**（V8 Isolate）                                       | latest     | グローバルエッジ・ゼロダウンタイムデプロイ・$0〜$5/月クラスの低コスト。Hono の真骨頂                                                                                                |
| **本番ビルド/デプロイ**       | **Wrangler**（Cloudflare 公式 CLI）                                        | ^3.x       | `wrangler deploy` 1 コマンドで本番反映。`wrangler dev` でローカルでも Workers 環境シミュレート可能                                                                                  |
| **ローカル開発ランタイム**    | Node.js                                                                    | 22 LTS     | TDD・デバッグ・Vitest 実行を快適に行うため。tsx watch でホットリロード                                                                                                              |
| Framework                     | Hono                                                                       | ^4.x       | 軽量・高速・型安全。**同一コードで Workers / Node / Vercel Edge / Bun / Deno** に展開可能                                                                                           |
| OpenAPI                       | @hono/zod-openapi                                                          | ^0.x       | Zod スキーマから OpenAPI 仕様を自動生成。二重管理不要                                                                                                                               |
| Validation                    | Zod                                                                        | ^3.x       | TypeScript ネイティブのスキーマバリデーション                                                                                                                                       |
| Database                      | Supabase (PostgreSQL 15)                                                   | —          | Auth + RLS + Realtime 込みの BaaS。Workers から **REST 経由**で接続するため TCP 直接続不可問題を回避                                                                                |
| DB Client                     | @supabase/supabase-js                                                      | ^2.x       | Supabase 公式クライアント。fetch ベースで Workers ネイティブ動作                                                                                                                    |
| Logger（本番 / Workers）      | `console.log(JSON.stringify(...))` ベース軽量実装（`createWorkersLogger`） | —          | Workers 環境では `fs` / `worker_threads` が使えないため pino を入れない。pino と同じ呼び出しスタイル（`logger.info({ ...bindings }, 'msg')`）と pino 互換の出力（level=数値）を維持 |
| Logger（ローカル開発 / Node） | pino + pino-pretty（**`devDependencies`**）                                | ^9.x       | Node ローカル開発時のみ整形ログ。`app/shared/infrastructure/node-pino-logger.ts` に物理隔離し、Workers バンドルに混入させない                                                       |
| Workers 型定義                | @cloudflare/workers-types                                                  | ^4.x       | `Env` バインディング型を提供                                                                                                                                                        |
| Test                          | Vitest                                                                     | ^3.x       | Vite ベース。高速・ESM ネイティブ・型安全。`@cloudflare/vitest-pool-workers` で Workers 環境テストにも拡張可能                                                                      |
| Package Mgr                   | pnpm                                                                       | ^9.x       | 高速・ディスク効率・モノレポ対応。**npm の使用（特に `npm i -g`）は禁止**（後述）                                                                                                   |
| Container                     | Docker Compose                                                             | —          | アプリコンテナのみ管理（**ローカル学習用途**）。本番は Workers なのでコンテナ不要                                                                                                   |
| Supabase Dev                  | Supabase CLI                                                               | latest     | ローカル環境・マイグレーション管理の公式ツール                                                                                                                                      |

---

## Architecture（DDD-lite）

### 採用コンセプト

- **Bounded Context（境界づけられたコンテキスト）** = `app/modules/{cakes,customers,orders}/`
  - 各コンテキストは独立して縦に積む。コンテキスト間の参照は最小限（基本は禁止、必要なら presentation 層で集約）
- **4 層構造**: 各コンテキスト内を `domain → application → infrastructure → presentation` に分ける
- **共有カーネル** = `app/shared/`
  - 全コンテキストが依存して良い純粋ユーティリティ（エラー基底・ロガー・env・error-handler 等）

### レイヤの役割と依存方向

```
┌──────────────────────────────────────────────────────────────────┐
│ presentation/   Hono ルート + Zod DTO + Controller              │ ← HTTP I/F
│      ↓ application を呼ぶだけ。domain には触れない              │
├──────────────────────────────────────────────────────────────────┤
│ application/    UseCase（1 ファイル = 1 ユースケース）          │ ← ビジネス手順
│      ↓ domain の interface に依存。infrastructure は知らない    │
├──────────────────────────────────────────────────────────────────┤
│ domain/         Entity / Value Object / Repository interface    │ ← 純粋層（最重要）
│      ↑ 外側を一切知らない。外部依存ゼロ                         │
├──────────────────────────────────────────────────────────────────┤
│ infrastructure/ Repository 実装（Supabase 呼び出し等）          │ ← 永続化・外部 I/O
│      ↓ domain の interface を実装する                           │
└──────────────────────────────────────────────────────────────────┘
```

**依存ルール**（CRITICAL — 違反したらレビューで差し戻し）:

1. `domain/` は外側のレイヤを **絶対に import しない**（`hono`, `supabase-js`, `@/shared/infrastructure/*` も禁止）
2. `application/` は `domain/` のみ import 可。`infrastructure/` の具象は触らず interface に依存
3. `infrastructure/` は `domain/` の interface を実装。`application/` は知らない
4. `presentation/` は `application/` のみ呼ぶ。`infrastructure/` を直接触らない（DI で組み立て済みの UseCase を使う）
5. **コンテキスト間の直接参照禁止**（`modules/orders/` から `modules/cakes/domain/` を import しない）

### 採用する DDD 戦術パターン

| パターン                       | 採用           | 適用場所                                        |
| ------------------------------ | -------------- | ----------------------------------------------- |
| Aggregate / Entity             | ✅             | 各コンテキストの `domain/`                      |
| Value Object                   | ✅（要所のみ） | `Price`, `OrderQuantity`, `Email`               |
| Repository（interface + 実装） | ✅ 必須        | interface = `domain/`、実装 = `infrastructure/` |
| UseCase（Application Service） | ✅ 必須        | 1 ユースケース = 1 ファイル                     |
| Domain Event                   | ✅ 1 箇所      | `OrderPlaced` で在庫減算（Phase 5）             |
| Domain Service                 | △ 必要時       | 跨る計算（合計金額算出など）                    |
| CQRS                           | ❌             | 規模に対して過剰                                |
| Specification パターン         | ❌             | 同上                                            |

### DI 戦略

**手動 DI（factory function）** を採用する。`tsyringe` 等は学習が分岐するため不採用。
`app/shared/composition-root.ts` でモジュールを組み立てて `createApp()` に注入する。

```typescript
// イメージ（Phase 3 で実装）
export const buildCakesModule = (sb: SupabaseClient) => {
  const repo = new CakeSupabaseRepository(sb);
  return {
    listCakes: new ListCakesUseCase(repo),
    createCake: new CreateCakeUseCase(repo),
  };
};
```

---

## Directory Structure

```
cake-shop-api/
├── app/                                              # アプリケーションコード（全 TypeScript）
│   ├── index.ts                                      # エントリーポイント（サーバー起動）
│   ├── app.ts                                        # Hono インスタンス・ミドルウェア・ルート集約
│   ├── modules/                                      # = Bounded Contexts
│   │   ├── cakes/
│   │   │   ├── domain/                               # ★純粋層（外部依存ゼロ）
│   │   │   │   ├── cake.ts                           # Entity / Aggregate Root
│   │   │   │   ├── price.vo.ts                       # Value Object
│   │   │   │   ├── cake.repository.ts                # interface（DI 用）
│   │   │   │   ├── cake.errors.ts                    # ドメイン例外
│   │   │   │   └── cake.test.ts                      # 単体テスト（共置）
│   │   │   ├── application/                          # UseCase 層
│   │   │   │   ├── list-cakes.usecase.ts
│   │   │   │   ├── list-cakes.usecase.test.ts        # in-memory repo で UseCase をテスト
│   │   │   │   ├── create-cake.usecase.ts
│   │   │   │   └── create-cake.usecase.test.ts
│   │   │   ├── infrastructure/                       # 外部世界の実装詳細
│   │   │   │   ├── cake.supabase-repository.ts       # Repository 実装
│   │   │   │   └── cake.supabase-repository.test.ts  # 実 Supabase ローカルでテスト
│   │   │   └── presentation/                         # HTTP I/F
│   │   │       ├── cake.routes.ts                    # Hono ルート + OpenAPI 定義
│   │   │       ├── cake.controller.ts                # 入出力 ↔ UseCase 変換
│   │   │       └── cake.dto.ts                       # Zod スキーマ（Request/Response）
│   │   ├── customers/                                # 同構造（Phase 4）
│   │   └── orders/                                   # 同構造 + Domain Event（Phase 5）
│   ├── shared/                                       # 共有カーネル
│   │   ├── domain/
│   │   │   ├── errors.ts                             # AppError + 5 サブクラス
│   │   │   └── errors.test.ts
│   │   ├── infrastructure/
│   │   │   ├── logger.ts                             # pino 構造化ログ
│   │   │   ├── logger.test.ts
│   │   │   └── supabase.ts                           # Supabase クライアント（Phase 3）
│   │   └── http/
│   │       ├── env.ts                                # Zod env 検証
│   │       ├── env.test.ts
│   │       └── error-handler.ts                      # app.onError ハンドラ
│   └── __tests__/
│       └── integration/                              # 跨り系の統合テスト
│           ├── health.test.ts
│           └── error-handler.test.ts
├── supabase/
│   ├── config.toml                                   # Supabase CLI 設定
│   ├── migrations/                                   # SQL マイグレーション（連番_説明.sql）
│   └── seed.sql                                      # 開発用初期データ
├── bruno/                                            # API テストコレクション（Bruno）
├── scripts/                                          # 体験用スクリプト（zero-downtime-watch.ps1 / .sh など）
├── .claude/
│   └── settings.json                                 # Claude Code プロジェクト設定
├── CLAUDE.md                                         # このファイル
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .prettierrc.json
├── .editorconfig
├── .env.example
└── .gitignore
```

---

## API Design

### バージョニング規則

- **全業務エンドポイントは `/v1` 配下に置く**（例: `GET /v1/cakes`）
- 非バージョンに置けるのは `/health`（ヘルスチェック）のみ
- 破壊的変更が必要な場合のみ `/v2` を新設し、`/v1` は維持する

### エンドポイント一覧

```
GET  /health                # ヘルスチェック（非バージョン・認証不要）

GET  /v1/cakes              # ケーキ一覧（認証不要）
POST /v1/cakes              # ケーキ登録（要認証・管理者ロール）

GET  /v1/customers          # 顧客一覧（要認証・管理者ロール）
POST /v1/customers          # 顧客登録（認証不要・サインアップ相当）

POST /v1/orders             # 注文作成（要認証）
GET  /v1/orders/:id         # 注文詳細（要認証・本人のみ）
```

### 統一エラーレスポンス形式

すべてのエラーは以下の形式で返す。クライアントがエラー種別をプログラムで判別できるよう `code` を必ず含める。

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "リクエストパラメータが不正です",
    "details": [{ "field": "price", "message": "0より大きい整数を指定してください" }]
  }
}
```

| HTTP Status | Error Code              | 意味                         |
| ----------- | ----------------------- | ---------------------------- |
| 400         | `VALIDATION_ERROR`      | Zod バリデーション失敗       |
| 401         | `UNAUTHORIZED`          | 認証トークン不正または未提供 |
| 403         | `FORBIDDEN`             | 権限なし（RLS ポリシー違反） |
| 404         | `NOT_FOUND`             | 指定リソースが存在しない     |
| 409         | `CONFLICT`              | 一意制約違反（メール重複等） |
| 500         | `INTERNAL_SERVER_ERROR` | 予期しないサーバーエラー     |

---

## Coding Conventions

### TypeScript

- `strict: true` + `noUncheckedIndexedAccess: true` を必須とする
- `any` 使用禁止。どうしても必要な場合は `unknown` + 型ガードで対処
- パスエイリアス: `@/*` → `app/*`

```typescript
// ✅ パスエイリアス使用例
import { logger } from '@/shared/infrastructure/logger';
import { AppError } from '@/shared/domain/errors';
```

### 関数・ファイルサイズ

- 関数は **50 行以内**（超えたら分割を検討）
- ファイルは **800 行以内**（超えたらモジュール分割）
- ネストは **4 階層以内**（早期 return / guard clause を使う）
- Controller / Routes は **30 行以内**を目安（薄く保つ。ロジックは UseCase へ）

### 命名規則

| 対象                | 規則                 | 例                                                           |
| ------------------- | -------------------- | ------------------------------------------------------------ |
| ファイル            | kebab-case + suffix  | `cake.repository.ts`, `list-cakes.usecase.ts`, `price.vo.ts` |
| 関数・変数          | camelCase            | `createCake`, `cakeId`                                       |
| 型・クラス          | PascalCase           | `Cake`, `Price`, `NotFoundError`                             |
| 定数                | SCREAMING_SNAKE_CASE | `MAX_ORDER_QUANTITY`                                         |
| DB テーブル・カラム | snake_case           | `order_items`, `unit_price`                                  |

#### ファイルサフィックス規約

| サフィックス               | 配置先            | 役割                             |
| -------------------------- | ----------------- | -------------------------------- |
| `*.repository.ts`          | `domain/`         | Repository interface             |
| `*.supabase-repository.ts` | `infrastructure/` | Repository 実装                  |
| `*.usecase.ts`             | `application/`    | UseCase                          |
| `*.routes.ts`              | `presentation/`   | Hono ルート定義（OpenAPI 含む）  |
| `*.controller.ts`          | `presentation/`   | Controller（入出力変換）         |
| `*.dto.ts`                 | `presentation/`   | Zod スキーマ（Request/Response） |
| `*.vo.ts`                  | `domain/`         | Value Object                     |
| `*.errors.ts`              | `domain/`         | ドメイン例外                     |

#### 永続化モデルの型命名規約（`domain` 多義使用の回避）

`domain` という語は **業務概念（Domain Model）専用** に予約する。infrastructure 層で DB 行を表す型は **`*Row` サフィックス** を付け、`infrastructure/domain/` のようなディレクトリは作らない。

| 種類              | レイヤ                                | 命名             | 例              | 振る舞い               |
| ----------------- | ------------------------------------- | ---------------- | --------------- | ---------------------- |
| Domain Model      | `domain/`                             | サフィックスなし | `Cake`, `Price` | あり                   |
| Persistence Model | `infrastructure/`（ファイルローカル） | `*Row`           | `CakeRow`       | なし（データ構造のみ） |

```typescript
// ✅ infrastructure 層: Persistence Model は Row サフィックス + ファイルローカル
// app/modules/cakes/infrastructure/cake.supabase-repository.ts
interface CakeRow {
  id: string;
  name: string;
  price: number;
  stock: number;
}

// ❌ infrastructure/domain/ ディレクトリの作成は禁止
// ❌ Persistence Model を Cake のように Domain Model と同名にすることは禁止
```

**禁止事項**:

- `infrastructure/domain/` のようなディレクトリ作成
- Persistence Model を Domain Model と同名にする（`Cake` vs `Cake` の衝突）
- Persistence Model を `domain/` や `application/` に export する（infrastructure 内に閉じる）

**理由**: Hexagonal / Clean / Onion Architecture では `domain` は単一意味で予約する。同じ語を別レイヤで再利用すると、DB の都合（snake_case / timestamptz 文字列等）が業務概念に混入する温床になる。`Row` サフィックスで物理的に区別する。

**他のサフィックス候補**（必要時のみ採用）:

| サフィックス | 用途                                          |
| ------------ | --------------------------------------------- |
| `*Row`       | RDB の 1 行（本プロジェクトの基本）           |
| `*Schema`    | テーブル構造定義 / Drizzle 等の Schema        |
| `*State`     | Aggregate の状態スナップショット（Vernon 流） |

### コメントの書き方

コメントは **「なぜ（Why）」を書く**。「何をするか（What）」はコードから読める。

```typescript
// ✅ Why を書く（良い例）
// Supabase の RLS が service_role キーをバイパスするため、
// 管理者操作には service_role クライアントを使う
const adminClient = createAdminSupabaseClient();

// ❌ What を書く（悪い例）
// Supabase クライアントを作成する
const client = createClient(url, key);
```

- 日本語・英語どちらでも可
- TODO は `// TODO: 内容` 形式で記録

### import 順序

```typescript
// 1. Node.js 標準モジュール（node: プレフィックス必須）
import { randomUUID } from 'node:crypto';
// 2. 外部ライブラリ
import { Hono } from 'hono';
import { z } from 'zod';
// 3. 内部モジュール（パスエイリアス）
import { logger } from '@/shared/infrastructure/logger';
// 4. 相対パス（同一レイヤ内のみ）
import { Cake } from './cake';
```

---

## Forbidden Patterns（禁止パターン）

```typescript
// ❌ presentation 層から DB を直接叩く（禁止）
app.get('/v1/cakes', async (c) => {
  const { data } = await supabase.from('cakes').select('*');
  return c.json(data);
});

// ❌ application 層から Supabase を import（禁止 — domain interface に依存する）
import { createClient } from '@supabase/supabase-js';

// ❌ domain 層から外側を import（禁止 — 純粋層を保つ）
import { logger } from '@/shared/infrastructure/logger'; // domain/ では NG
import { Hono } from 'hono'; // domain/ では NG

// ❌ コンテキスト間の直接参照（禁止）
import { Cake } from '@/modules/cakes/domain/cake'; // orders/ では NG
```

**禁止項目まとめ**:

- DB アクセスは **`infrastructure/` 配下のみ**（presentation・application から直接禁止）
- `domain/` レイヤから外側のレイヤを import 禁止
- コンテキスト間の直接参照禁止（`modules/orders/` から `modules/cakes/domain/` を import しない）
- 環境変数のハードコード禁止（必ず `.env` + `@/shared/http/env` 経由）
- `console.log` のコミット禁止（`@/shared/infrastructure/logger` を使う）
- マイグレーションファイルの**編集**禁止（新規追加のみ）
- `/v1` プレフィックスなしの業務エンドポイント追加禁止
- `any` 型の使用禁止
- `infrastructure/domain/` ディレクトリ作成禁止（`domain` の多義使用回避。Persistence Model は `*Row` サフィックスで命名）
- **Cloudflare Workers 互換性を壊す Node 専用 API の使用禁止**（`fs`, `child_process`, `net` 生 TCP, `process.cwd()` 等）。本番デプロイ先が Workers のため、これらに依存すると本番で動かなくなる。どうしても Node 環境に閉じた処理が必要なら `app/index.node.ts` 側だけに置き、共通ロジック（`app.ts` 以下）には漏らさない
- **ネイティブモジュール（C 拡張）の依存禁止**（`bcrypt`, `sharp`, `pino-pretty` の本番投入等）。Workers では動かない。本番ロジックには Web 標準 API ベースのライブラリのみ採用
- **Node 専用パッケージは `devDependencies` に配置**（`pino`, `pino-pretty`, `@hono/node-server` 等）。`dependencies` には Workers / Node 双方で動くものだけを置く。`pino` は `app/shared/infrastructure/node-pino-logger.ts` に隔離して `app/index.node.ts` からのみ import すること（`app/shared/infrastructure/logger.ts` から pino を import すると Workers で `process is not defined` で落ちる）
- **npm の使用禁止（特に `npm i -g`）**。本リポジトリの依存解決は **pnpm 一本**（`packageManager: "pnpm@..."` で固定）。`npm install` / `npm i -g` / `npx` は**使わない**。理由: 2024〜2026 にかけて npm registry を経由したサプライチェーン攻撃（typosquatting・既存パッケージ乗っ取り・malicious postinstall）が連発しており、グローバル `npm i -g` は最も攻撃面が広い。CLI 系ツール（supabase / wrangler 等）は OS のパッケージマネージャ（**scoop / winget / Homebrew / mise** 等）か公式バイナリで入れる。一時実行は `pnpm dlx <pkg>`（npx 相当）に置き換える

---

## Testing Strategy

### 方針: TDD（テスト駆動開発）

1. **RED**: 失敗するテストを書く
2. **GREEN**: テストが通る最小実装をする
3. **REFACTOR**: コードを整理する

### テスト分類と配置

`vitest.config.ts` の `projects` で **2 プールに分割**（Phase 7 / Step 9 後の保留タスクで導入）。`pnpm test` 一発で両プールが順に走る。

| プール      | ランタイム           | 速度 | 対象                                                                                                                                  |
| ----------- | -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `node-unit` | Node (threads)       | 速い | `modules/*/domain` / `modules/*/application` / `shared/domain` / `shared/http` / 純粋な shared/infrastructure（logger / supabase 等） |
| `workers`   | workerd（miniflare） | 遅い | `modules/*/infrastructure` / `__tests__/integration` / `jwks-fetcher`                                                                 |

| 種類                   | プール      | 対象                                 | 配置                         | DB                            |
| ---------------------- | ----------- | ------------------------------------ | ---------------------------- | ----------------------------- |
| 単体（domain）         | `node-unit` | Entity / VO / Repository interface   | 実装と共置（`*.test.ts`）    | 不要                          |
| 単体（application）    | `node-unit` | UseCase（in-memory repo で差し替え） | 実装と共置                   | 不要                          |
| 単体（infrastructure） | `workers`   | Repository 実装                      | 実装と共置                   | **必要**（Supabase ローカル） |
| 統合（presentation）   | `workers`   | routes / controllers                 | `app/__tests__/integration/` | UseCase mock or 実 Supabase   |
| 統合（shared 跨り）    | `workers`   | error-handler 等                     | `app/__tests__/integration/` | 不要                          |
| E2E                    | —           | 全エンドポイント疎通                 | `bruno/`                     | 必要                          |

**狙い**: typecheck だけでは検出できない Workers 互換事故（`node:crypto` 等の Node 専用 API・トップレベル `process.env`・pino 引きずり込み等）を、本番と同じ workerd 上で `infrastructure/` と `__tests__/integration/` を回すことで弾く。純粋層は速度優先で Node プールに残す。

**workers プールでのテスト実装上の注意**:

- workerd 上では `process.env` が空。`loadEnv()` に渡す env は `cloudflare:test` の `env`（= `vitest.config.ts` の `miniflare.bindings` で注入された値）を `loadEnv(workerEnv as unknown as RawEnv)` で渡す
- `cloudflare:test` モジュールの型は `app/__tests__/cloudflare-test.d.ts` の triple-slash reference で取り込む（本番ビルドの `tsconfig.json` `types` を汚さないため）
- 依存版: `@cloudflare/vitest-pool-workers@0.8.x` が vitest 3.x の peer（0.15.x 以降は vitest 4.x 必須で `/config` サブパスも撤去されているため、vitest 3.x のままなら 0.8 系を pin する）

### 共置テストの利点（DDD-lite で重要）

- **ドメイン層が DB 非依存** → in-memory 実装で UseCase テストが**爆速**
- リファクタ時に実装とテストが一緒に動く
- 1 ファイル削除でテストも一緒に消える

### カバレッジ目標

- **80% 以上必須**（`vitest.config.ts` で閾値を設定し、未達はビルドエラー扱い）

---

## Authentication（Supabase Auth）

### 方針

- Supabase Auth の JWT を使用（`Authorization: Bearer <token>` ヘッダ）
- 認証ミドルウェアは `app/shared/http/auth.middleware.ts` に配置（Phase 6）
- JWT を検証し、`c.set('user', user)` で Hono コンテキストに保存
- 認証不要なエンドポイント: `GET /health`, `POST /v1/customers`, `GET /v1/cakes`
- 認証必須なエンドポイント: それ以外すべて

### RLS（Row Level Security）

- `orders` テーブル: 本人のみ参照・作成可能
- `cakes` テーブル: 全員参照可。INSERT は管理者ロールのみ
- RLS ポリシーは `supabase/migrations/` に SQL で定義する

---

## Database Rules

- DB アクセスは **`app/modules/*/infrastructure/` 配下のみ** に限定する
- マイグレーションは `supabase/migrations/NNNN_description.sql` 形式
- スキーマ変更は **新規マイグレーションファイルで追加**（既存ファイルの編集禁止）
- UUID は DB 側の `gen_random_uuid()` で生成（アプリ側で指定しない）
- タイムゾーンは **UTC** で統一（クライアント側で変換）
- `orders` 作成時の在庫減算は **Postgres Function** でトランザクション管理（アトミック保証）

---

## Logger Usage

障害対応・QA 対応ができるよう、構造化ログで文脈情報を残す。

```typescript
import { logger } from '@/shared/infrastructure/logger';

// ✅ 構造化ログ（JSON 形式。Cloudflare Logs / Datadog 等で検索可能）
logger.info({ orderId, customerId }, 'Order created successfully');
logger.error({ err, orderId }, 'Failed to create order');
logger.warn({ userId, path: '/v1/orders' }, 'Unauthorized access attempt');

// ❌ console.log の直書き禁止（コミット不可。logger 経由で出す）
console.log('order created');
```

**ログを書く場所**: `application/` または `infrastructure/`（`domain/` は副作用ゼロを保つため不可）。

### ランタイム別の実装方針

本プロジェクトはローカル = Node、本番 = **Cloudflare Workers** の二段構えのため、ロガーも環境別に実装を切り替える。`logger.ts` の **interface（`info` / `warn` / `error` / `debug` / `child` 等）はランタイム共通**にして、コンテキスト側のコードは差し替えに気付かないように保つ。

| 環境                           | 実装                                     | 補足                                                                                                                                                 |
| ------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ローカル開発（Node 22）        | **pino + pino-pretty**                   | 整形表示で TDD・デバッグを快適に。`pino-pretty` は **devDependency 限定**                                                                            |
| 自動テスト（Vitest）           | **pino（silent）** または ダミー実装     | 統合テストで `pino({ level: 'silent' })` を注入、ログ汚染を防ぐ                                                                                      |
| **本番（Cloudflare Workers）** | **Workers 互換ロガー**（Phase 7 で導入） | `console.log(JSON.stringify(...))` ベースの軽量実装、または `@logtape/logtape` のようなランタイム不問ライブラリ。**`pino-pretty` / `fs` 依存は禁止** |

`shared/infrastructure/logger.ts` は **factory function（`createLogger(env)`）** で実装を分岐できる構造を維持し、`composition-root` / `index.workers.ts` 側で本番実装を注入する。

### ログレベル基準

| レベル  | 使いどころ                                       |
| ------- | ------------------------------------------------ |
| `error` | 例外・障害（即時対応が必要）                     |
| `warn`  | 異常だが処理は継続できる                         |
| `info`  | 正常系のビジネスイベント（注文作成・顧客登録等） |
| `debug` | 開発時のデバッグ情報（本番は無効化）             |

---

## Workflow for AI Agents（Claude Code 向け手順）

### 新コンテキスト追加（縦切り）

1. **CLAUDE.md を確認** → 現フェーズ・依存ルール・禁止パターンをチェック
2. **planner agent** → 実装計画を立案
3. **tdd-guide agent** → テスト先行で実装（RED → GREEN → REFACTOR）
4. **コンテキスト内を 4 層順に実装**（下記「実装順序」参照）
5. **code-reviewer agent** → コードレビュー
6. **security-reviewer agent** → 認証・DB アクセス変更時は必須

### 実装順序（厳守 — 縦切り）

各 Bounded Context は以下の順で完成させる:

```
1. domain/         Entity / VO / Repository interface / ドメイン例外
2. application/    UseCase（in-memory repo でテスト）
3. infrastructure/ Repository 実装（Supabase）+ マイグレーション
4. presentation/   Zod DTO → Routes → Controller（OpenAPI も同時に書く）
5. composition-root.ts に組み立て + app.ts でマウント
```

### DB 変更時の手順

1. 新規マイグレーション SQL を作成（`supabase/migrations/NNNN_*.sql`）
2. `seed.sql` を必要に応じて更新
3. 影響を受けるコンテキストの `domain/` で型を更新
4. `infrastructure/` の Repository 実装を更新
5. `application/` UseCase は domain interface 経由なので最小限の修正で済むはず

### コミット前の品質ゲート（必ず通す）

- **pre-commit フック（husky + lint-staged）が自動で走る**: ステージされたファイルに対して `eslint --fix` / `prettier --write` を実行。修正不能なエラーがあればコミットを中断する。詳細は README の「ローカルの品質ゲート（pre-commit / verify）」参照
- **push 前は `pnpm verify` を必ず叩く**: `lint + typecheck + format:check + test` を一括実行。CI と同じセットなので、ここが緑なら CI もほぼ緑（過去に `format:check` だけローカルで踏まずに staging deploy が落ちた事故あり）
- **`git commit --no-verify` でフックを潰すのは禁止**（CI で結局赤くなる）

### コミット前の README 同期チェック（MUST — agent が自動で実施）

コミット作成時、Claude は **必ず以下を判定** し、該当すれば README.md（および必要なら CLAUDE.md）の修正を**同じコミットに含めて**から `git commit` する。
ユーザーが「README は今回更新不要」と明示した場合のみ省略可。

**README 更新が必要なケース（チェックリスト）**:

- [ ] **フェーズ進捗の変化**（Phase X / Step Y が完了 → README 末尾の進捗チェックリストを `[x]` に + 完了日 + 学んだことの要約）
- [ ] **公開コマンド / スクリプトの追加・変更**（`package.json` の `scripts` 追加、`scripts/` 配下の新規ファイル → README の「主要コマンド」「体験用スクリプト」節を更新）
- [ ] **環境変数の追加・削除・意味変更**（`.env.example` を直したら README の「環境変数」節も対応する。`wrangler.toml` の `vars` / `[env.*]` も同様）
- [ ] **エンドポイントの追加・削除・契約変更**（HTTP method / path / 認証要否 / レスポンス形式 → README の「API Design」節）
- [ ] **アーキテクチャ・設計判断の変更**（依存方向ルール、新しい禁止パターン、ファイルサフィックス規約、新しいレイヤ → CLAUDE.md と README 両方）
- [ ] **デプロイ・CI/CD・運用フローの変更**（GitHub Actions、`wrangler.toml` env 構成、リリース手順 → README「CI/CD・環境構成の指針」節）
- [ ] **本番 / staging URL・プロジェクト識別子の追加**（README のチートシート系の節 / プレースホルダ表記との整合）
- [ ] **ローカル開発のセットアップ手順を変える変更**（`pnpm` スクリプト名の改名、新規依存のインストール手順、Docker / Supabase CLI の前提変更）
- [ ] **新しい罠・落とし穴の発見**（同じ環境で再発しうるもの → README の該当節か、なければ「## トラブルシューティング」相当に追記）

**README 更新が不要なケース**（=コードだけ直して終わる）:

- 純粋なリファクタ・命名整理・型の絞り込み
- 既存テストの修正・追加（実装の挙動は変えない）
- ライブラリの patch バージョン更新（API 互換）
- フォーマット / lint 修正のみ
- 内部実装の差し替え（外部 I/F が変わらないもの。例: 同じ interface を保ったまま `infrastructure/` の Repository 実装を入れ替える）

**運用上の手順**（agent はこの順で動く）:

1. `git status` / `git diff` でステージ済みの変更を確認
2. 上記チェックリストに 1 つでも該当するか判定
3. 該当する → README.md（および CLAUDE.md）の修正案を提示 → ユーザー承認 → 同一コミットに含める
4. 該当しない → そのままコミット
5. 迷ったら**ユーザーに確認**（「この変更で README は更新不要でいいか？」と一言聞く）

**Why**: コードと README の乖離はフォーク者・将来の自分・新メンバーの最初のハマりポイントになる。
本プロジェクトでは README が「学習プロジェクトの単一の真実」を担う設計（フェーズ進捗・運用ポリシー・主要コマンドの一覧）なので、ここがコードに追従しないと CLAUDE.md だけ更新して README が陳腐化する事故が起きやすい。
過去にも「Phase 完了したのに README のチェックボックスだけ `[ ]` のまま」「`package.json` に新規 script を足したのに README の表に出てこない」が複数回発生済。

---

## Implementation Progress（実装進捗）

> フェーズ完了時にチェックを入れてください

- [x] **Phase 1**: 設定ファイル群・プロジェクト初期化
- [x] **Phase 2**: Hono アプリ骨格 + `/health` + 統一エラー + 構造化ログ + env 検証
- [x] **Phase 2.5（軌道修正）**: DDD-lite 4 層構造への移行（`app/lib/` → `app/shared/`、`app/modules/{cakes,customers,orders}` 骨格）
- [x] **Phase 3**: `cakes` Bounded Context（domain → application → infrastructure → presentation の縦切り完成）
- [x] **Phase 4**: `customers` Bounded Context（同構造）
- [x] **Phase 5**: `orders` Bounded Context（Domain Event + Postgres Function でアトミック在庫減算）
- [x] **Phase 6**: 認証（Supabase Auth + RLS + 認証ミドルウェア）+ OpenAPI 仕上げ
- [x] **Phase 7**: **Cloudflare Workers 化**（本番デプロイ想定の最終段）
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

### CI/CD・リリース運用の要点（README に詳細）

- **ブランチ→環境**: `develop` push = staging に自動デプロイ（即時 100%）／`main` push = production（`versions upload` 0% → **GitHub Environment `production` の手動承認** → `deploy@100`）。feature → PR → CI → `develop` マージ → 区切りで `develop`→`main` PR → マージで本番。ロールバックは `wrangler rollback --env production`
- **`main` はブランチ保護必須**: PR 経由のみ・CI チェック必須・force push/削除禁止。本番に出すコードは必ず CI を通った `main` の内容
- **シークレットの置き場を分ける**: アプリのシークレット（`SUPABASE_*`）は実行環境（`wrangler secret put --env <name>`）／CI のシークレット（`CLOUDFLARE_API_TOKEN` 等）は GitHub リポジトリ Secrets。リポジトリにも他方にも混ぜない
- **Supabase は 1 環境 1 プロジェクト**: production / staging で別プロジェクト。**本番データを staging に流さない**（合成・匿名化シード `supabase/seed.staging.sql` を使う）。マイグレは前方向のみ・`supabase db push`、アドホック SQL は `supabase db query --linked -f`
- **ドキュメント上の識別子の線引き**: 個人固有の値（Cloudflare アカウントサブドメイン・Supabase project ref）は `<...>` プレースホルダ表記。構成上の固有名（Worker 名 `cake-shop-api` / プロジェクト名 `Hono-Supabase` / env 名）はそのまま残す（フォーク者が「これ何？」にならないように）
- [x] **Phase 8（2026-05-14 完了）**: **Supabase Auth メール運用**（確認メールのテンプレート / Custom SMTP / 確認後リダイレクト設計）
  - 動機: 「Supabase Auth を使うバックエンド担当」が「確認メールのテンプレートを更新できる・Custom SMTP に切替えられる」を一度も触らないのは学習漏れ。本番が `enable_confirmations = ON`（＝正しい設定）である以上、その運用面を一周しておく
  - [x] **Step 1（2026-05-13 完了）**: ローカルで `supabase/config.toml` の `[auth.email] enable_confirmations = true` に変更（＝本番 Cloud に合わせた）。`POST /v1/customers` → Mailpit/Inbucket（http://localhost:54324）に確認メール受信 → 確認リンク（`/auth/v1/verify?token=...&type=signup&redirect_to=<site_url>`）を踏むと 303 + `auth.users.email_confirmed_at` がセット／確認前ログインは 400 `email_not_confirmed`／確認後ログインで JWT 取得、を実機確認。**この変更で顕在化したバグも修正**: `enable_confirmations = ON` だと `auth.signUp()` がセッションを返さない → サインアップ経路の sb は anon のまま → 直後の「トリガが作った `customers` 行を `authUserId` で読み戻す」が RLS で弾かれ 404 になっていた（本番も同じ潜在バグ）。`composition-root.ts` でサインアップ用に `CustomerSupabaseRepository(createAdminClient(env))` を 1 本足し、サインアップ経路の `customers` 参照のみ RLS バイパスの service_role 経由に（`auth.signUp()` 自体は公開 auth 操作なので anon のまま）。副次効果として `findByEmail` の重複チェックが実際に効くようになり、同一メール再登録が 409 `CONFLICT` を返すようになった
  - [x] **Step 2（2026-05-14 完了）**: メールテンプレートを **リポジトリ管理**化。`supabase/templates/{confirmation,recovery,magic_link,email_change}.html` を新設（日本語＋ブランド色 `#b85c5c`・テーブルレイアウト + インライン CSS で HTML メール互換）。`supabase/config.toml` の `[auth.email.template.*]` 4 セクションを有効化、件名を `【ケーキショップ】…` に日本語化。Go template 変数（`{{ .ConfirmationURL }}` / `{{ .Token }}` / `{{ .SiteURL }}` / `{{ .Email }}` / `{{ .NewEmail }}` / `{{ .Data }}`）の使い方を冒頭コメントに整理。confirmation メールは Mailpit で実機表示を確認済（recovery / magic_link / email_change は同じ仕組みなので個別検証は省略）。`.prettierignore` に `supabase/templates/` を追加（HTML メールの属性改行を prettier に壊させないため）
  - [x] **Step 3（2026-05-14 完了）**: 確認後リダイレクトの三層設計（`site_url` / `additional_redirect_urls` / `redirect_to`）と PKCE/Implicit フローを整理し、README に新節「## 認証メールのリダイレクト設計（Supabase Auth・Phase 8 Step 3）」を追加。`additional_redirect_urls` に将来のフロント用 `http://127.0.0.1:3000/auth/callback` を許可リストとして追加（着地先の切替コスト最小化）。フロント不在での実機観察手順（Mailpit からリンク → `?code=...` でブラウザのアドレスバーに着地 → PKCE 動作確認）と、フロント有り時の Next.js App Router `app/auth/callback/route.ts` の理屈（`exchangeCodeForSession` + `type` 分岐 + cookie 保存）も README に明記
  - [x] **Step 4（2026-05-14 完了 — 方針変更）**: 当初は「ローカルで `[auth.email.smtp]` を Resend に切替えて実メール送信を体験」と定義していたが、実行段階で **ホスト Windows の Norton Antivirus "Web/Mail Shield" が outbound TLS を巻き取り、自社 CA で再署名する** ため、gotrue コンテナ → smtp.resend.com の TLS 検証が `x509: certificate signed by unknown authority` で必ず失敗することが判明（PowerShell の生 TLS で確認した Issuer が `CN=Norton Web/Mail Shield Root` だった）。Norton Root を コンテナの CA 束に注入する案は学習リポジトリの clean さを壊し、Norton の TLS スキャンを切る案は PC のセキュリティ運用を犠牲にするため不採用。**Step 5 と統合して「Cloud 上の Supabase に直接 Resend を繋ぐ」に再定義**することで、Custom SMTP の学習目的（設定経験・送信元検証・ブランド差出人）は完全達成可能と判断。リポジトリには「ローカルで実 SMTP 検証は TLS インスペクション環境では成立しない」旨を `supabase/config.toml` のコメントブロック / `.env.example` / README に記録（同じ罠を踏まないため）。ローカルは引き続き Inbucket（http://127.0.0.1:54324）で運用
  - [x] **Step 5（2026-05-14 完了）**: **Cloud 上の Supabase（production / staging）に Custom SMTP を直接設定して実メール送信** — Resend を無料枠 + ドメイン未認証で運用（自前ドメイン未取得のため `onboarding@resend.dev` を Sender、Sender Name `ケーキショップ` でブランド感だけ確保）。Supabase Dashboard → Authentication → Emails の **SMTP Settings**（Host=`smtp.resend.com` / Port=587 / Username=`resend` / Password=Resend API key、staging / production で別 API key）と **Templates**（Confirm sign up / Reset password / Magic link / Change email address の Subject + Body を `supabase/templates/*.html` の中身で上書き）を staging → production の順で設定。staging で `POST /v1/customers` → Gmail に「ケーキショップ \<onboarding@resend.dev\>」差出人・日本語テンプレで確認メール到達（DKIM `resend.dev` 署名で Gmail スパムフィルタ通過）→ 確認リンク踏破 → URL ハッシュに JWT（`email_verified: true`）が乗って戻ってくる、まで end-to-end 確認。**production への Phase 8 Step 1 admin client 修正の本番反映を Phase 7 Step 9 の本番リリースパイプライン（`develop`→`main` PR → CI 緑 → `versions upload --env production`（0%）→ Environment `production` 承認ゲート → `versions deploy <id>@100`）で実施** — 本番 `POST /v1/customers` で 409 CONFLICT（メール重複）が返ることを確認＝ admin クライアント経由の `findByEmail` が本番で正しく動作する証拠。**罠**: Resend 無料枠の宛先制限は SMTP の `RCPT TO` 生文字列を見るため、Gmail の `+alias` トリック（例 `online384+prod@gmail.com`）は別宛先として弾かれる（`Error sending confirmation email`）。完全一致で叩く or 自前ドメインを Resend で認証する
- [ ] **Phase 9**: **観測・運用の質を上げる**（本番運用を想定したロギング・ヘルス・メトリクス・アラート）
  - 動機: Phase 7 で Workers 互換ロガー（pino 互換 JSON 出力）の土台は整ったが、「障害が起きた時に 1 リクエストで吐かれた全ログを追える」「依存サービスの異常を `/health` で検知できる」「エラー率が急騰したらアラートが飛ぶ」までは未整備。**本番に出した API を運用できる状態**にするための観測ハードを一周する
  - [x] **Step 1（2026-05-15 完了）**: リクエスト ID 伝播 + リクエストスコープロガー — `app/shared/http/request-context.middleware.ts` を新設し、入口で `X-Request-Id` ヘッダを採用（サニタイズ `/^[A-Za-z0-9_-]{1,128}$/` を通らない値はログ汚染対策として拒否）→ 無ければ `crypto.randomUUID()`（Web Crypto API、Workers / Node 22 双方に組み込み）で生成。`AppVariables` に `requestId?` / `logger?` を追加し、`c.set('logger', baseLogger.child({ requestId, method, path }))` で req スコープロガーを積む。`createApp` に `globalMiddlewares` フィールドを足して `*`（`/health` 含む全パス）に適用 — 外形監視からの叩きも追跡可能。レスポンスヘッダ `X-Request-Id` に反射（クライアントが障害報告時に貼ってもらう運用）。`error-handler` を `c.get('logger') ?? fallbackLogger` 優先に切替（child binding に requestId / method / path が乗るので重複出力を削除）。`createModulesMiddleware` も `c.get('logger') ?? deps.logger` を採用し、per-request UseCase / Repository が req スコープロガーを引くように。テストは middleware の単体（7 ケース: 有効ヘッダ採用 / 未指定で自前生成 / 空白拒否 / 不許可文字拒否 / 128 文字超拒否 / child bindings 検証 / デフォルト UUID v4 形式）+ `pnpm verify` 緑（267 テスト）+ `pnpm test:coverage` 緑（middleware 100% カバー）
  - [x] **Step 2（2026-05-15 完了）**: アクセスログミドルウェア — `app/shared/http/access-log.middleware.ts` を新設。入口で `start = Date.now()`、出口で `{status, duration_ms, userId}` を req スコープロガー経由で出力（`method` / `path` / `requestId` は Step 1 の child binding に既に乗っているため二重出力しない）。ステータス別レベル出し分け（5xx → `error` / 4xx → `warn` / 他 → `info`）。`userId` は `c.get('user')?.id` を spread で未認証時にキーごと省略（`userId: undefined` を残さない）。`bootstrap.ts` で `requestContextMiddleware` の直後に並べて `/health` 含む全パスに適用。Hono 標準 `logger()` を使わない理由 = console.log プレーンテキストで structured 検索不可 + req スコープロガーの requestId バインドを引き継げない。`logger` 未挿入経路では no-op（fallback logger 入れると Workers バンドルに pino / 裸 console を混ぜるリスク）。テスト 6 ケース（2xx info / 4xx warn / 5xx error / 認証済 userId 出力 / 未認証 userId 省略 / logger 未挿入時 no-op）+ `pnpm verify` 緑（273 テスト）+ `pnpm test:coverage` 緑（middleware 100% カバー）
  - [ ] **Step 3**: `/health` の充実 — 現状 `{status:'ok', version}` だけのものを、Supabase REST に軽量 `select('id').limit(1)` を投げて `db: {ok, latency_ms}` を返す形に強化。ステータスを `ok | degraded | down` に階段化（外形監視・uptime monitor から叩いて pager に乗せる前提）
  - [ ] **Step 4**: メトリクス収集（Workers Analytics Engine） — `wrangler.toml` に `[[analytics_engine_datasets]]` を追加し、注文数 / エラー率 / p95 latency 等を書き込み。Node では no-op（Workers 限定 binding なので DI で吸収）。Cloudflare Dashboard でグラフ化、SQL クエリ可能であることを確認
  - [ ] **Step 5**: Logpush / アラート — Cloudflare Logs を R2 / 外部 SaaS（Logpush）に送る設定 + Notifications でメール / Slack 連携。「わざと 5xx を出してアラートが飛ぶ」演習で end-to-end 確認
- [ ] **Phase 10**: **API のリッチ化**（実務 REST API でよく出てくる設計パターンを縦切りで実演）
  - 動機: 現状の cakes/customers/orders は MVP 規模。実運用 API なら必須レベルの「ページネーション / ソート / 検索 / 楽観ロック / Rate Limit / Idempotency-Key / Webhook」を**設計判断の練習場**として一周する。それぞれ単独の機能というより「設計上のトレードオフを言語化する素材」として扱う
  - [ ] **Step 1**: ページネーション — cursor-based（`?after=<id>&limit=20`）を採用。理由は「offset/limit は LIMIT が大きい時に slow query になり、新規 INSERT で zip がズレる」「学習プロジェクトで両方は冗長」。`/v1/cakes` `/v1/orders` に導入。`Link` ヘッダ（RFC 5988）/ レスポンスボディ `next_cursor` 両論併記でユーザーに選んでもらう
  - [ ] **Step 2**: ソート・フィルタ — `?sort=-created_at,name` のような RFC 想定書式と Zod 検証。`/v1/cakes?available=true` のような単純フィルタ
  - [ ] **Step 3**: 検索 — Postgres `pg_trgm` か `tsvector` で部分一致 / 全文検索を実装（学習として両方の使い分けを言語化）
  - [ ] **Step 4**: 楽観ロック — `ETag` + `If-Match` で更新時の競合検知。Cake の在庫更新（追加発注）に導入。`409 CONFLICT` を出す
  - [ ] **Step 5**: Rate Limit — Cloudflare Workers の Rate Limiting API（無料枠）or Hono の `rateLimiter` ミドルウェア。IP / userId 別の制限。429 + `Retry-After` ヘッダ
  - [ ] **Step 6**: Idempotency-Key — `POST /v1/orders` で重複作成を防ぐ。`Idempotency-Key` ヘッダを受け取り、初回成功レスポンスを KV / DB にキャッシュ → 同キー再送で同レスポンスを返す（Stripe API スタイル）
  - [ ] **Step 7**: Webhook 配信 — 「注文確定」のドメインイベントを外部 URL に POST する仕組み。HMAC 署名 + retry-with-backoff + DLQ 設計

---

## Common Commands

```bash
# 開発サーバー起動（ホットリロード）
pnpm dev

# TypeScript ビルド
pnpm build

# テスト実行
pnpm test

# カバレッジ付きテスト
pnpm test:coverage

# Lint チェック
pnpm lint

# コードフォーマット
pnpm format

# 型チェック
pnpm typecheck

# 手動の総合チェック（CI が回しているのと同じセット = lint + typecheck + format:check + test）
# push 前 / PR 前にローカルで一度叩く運用
pnpm verify

# Supabase ローカル起動（Docker が起動している必要あり）
supabase start

# マイグレーション適用
supabase db push

# Supabase Studio（ブラウザ管理画面）→ http://localhost:54323
# Supabase 停止
supabase stop

# Docker Compose（アプリのみ・ローカル学習用途）
docker compose up -d
docker compose down

# --- Cloudflare Workers ---
# wrangler.toml は --env <name> 必須運用（[env.staging] / [env.production] を明示定義）。
# pnpm wrangler:* スクリプトに env を埋め込んであるので、素の wrangler deploy は使わない。

# Workers ローカル起動（V8 Isolate を再現する公式ツール）
pnpm wrangler:dev

# デプロイ（env ごと）
pnpm wrangler:deploy:staging
pnpm wrangler:deploy:production

# シークレット登録（env ごとに 3 回ずつ。secret は Worker 名単位のストア）
pnpm wrangler:secret:staging SUPABASE_URL
pnpm wrangler:secret:staging SUPABASE_ANON_KEY
pnpm wrangler:secret:staging SUPABASE_SERVICE_ROLE_KEY
pnpm wrangler:secret:production SUPABASE_URL
pnpm wrangler:secret:production SUPABASE_ANON_KEY
pnpm wrangler:secret:production SUPABASE_SERVICE_ROLE_KEY

# ログ tail（env ごと）
pnpm wrangler:tail:staging
pnpm wrangler:tail:production

# リンク済み Supabase プロジェクトに SQL を実行（Management API 経由・DB パスワード不要）
supabase db query --linked -f supabase/seed.staging.sql

# ゼロダウンタイム観察ループ（Step 9 (a) 体験用）— 別ターミナルで pnpm wrangler:deploy:staging を打ちながら眺める
pwsh scripts/zero-downtime-watch.ps1          # bash 版: bash scripts/zero-downtime-watch.sh
# 稼働中の deployment 一覧（デプロイ前後で確認）
pnpm exec wrangler deployments list --env staging

# バージョン管理（カナリアリリース）— Step 9 で扱う
pnpm exec wrangler versions upload --env production
pnpm exec wrangler versions deploy --env production
pnpm exec wrangler rollback --env production
```

---

## Environment Variables

本番値は**絶対にコミットしない**。

### ランタイム別の管理方法

| ランタイム                     | 管理方法                                     | ファイル                                          |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| ローカル開発（Node）           | `.env`（Node 22 の `--env-file` で読み込み） | `.env`（gitignore 済）/ `.env.example`            |
| 自動テスト（Vitest）           | `process.loadEnvFile()` で `.env` を注入     | `vitest.config.ts` 内                             |
| **本番（Cloudflare Workers）** | **`wrangler secret put` でクラウド側に登録** | `.dev.vars`（Workers ローカル用、gitignore 必須） |

### 主な環境変数

| 変数名                      | 説明                                                                              | 例                                                                      |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase プロジェクト URL                                                         | `http://localhost:54321`（ローカル）/ `https://xxx.supabase.co`（本番） |
| `SUPABASE_ANON_KEY`         | 匿名キー（公開可・RLS で保護）                                                    | `eyJ...`                                                                |
| `SUPABASE_SERVICE_ROLE_KEY` | サービスロールキー（RLS バイパス・厳重管理）                                      | `eyJ...`                                                                |
| `PORT`                      | サーバーポート（**Node ローカル時のみ使用**。Workers は無関係）                   | `3010`                                                                  |
| `NODE_ENV`                  | 実行環境（**Node ローカル時のみ**。Workers は `wrangler.toml` の env 機能で代替） | `development` / `production` / `test`                                   |
| `LOG_LEVEL`                 | ログ出力レベル                                                                    | `debug` / `info` / `warn` / `error`                                     |

> **Phase 7 で Cloudflare Workers 化する際の補足**: Workers では `process.env` ではなく **第二引数の `Env` バインディング**から変数を取得する設計になる。`@/shared/http/env` の loadEnv も Workers 側では `c.env` を受け取る形に分岐させる（interface はそのまま、入力源だけ差し替え）。
