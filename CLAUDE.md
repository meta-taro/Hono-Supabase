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
| Package Mgr                   | pnpm                                                                       | ^9.x       | 高速・ディスク効率・モノレポ対応                                                                                                                                                    |
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

---

## Testing Strategy

### 方針: TDD（テスト駆動開発）

1. **RED**: 失敗するテストを書く
2. **GREEN**: テストが通る最小実装をする
3. **REFACTOR**: コードを整理する

### テスト分類と配置

| 種類                   | 対象                                 | 配置                         | DB                            |
| ---------------------- | ------------------------------------ | ---------------------------- | ----------------------------- |
| 単体（domain）         | Entity / VO / Repository interface   | 実装と共置（`*.test.ts`）    | 不要                          |
| 単体（application）    | UseCase（in-memory repo で差し替え） | 実装と共置                   | 不要                          |
| 単体（infrastructure） | Repository 実装                      | 実装と共置                   | **必要**（Supabase ローカル） |
| 統合（presentation）   | routes / controllers                 | `app/__tests__/integration/` | UseCase mock or 実 Supabase   |
| 統合（shared 跨り）    | error-handler 等                     | `app/__tests__/integration/` | 不要                          |
| E2E                    | 全エンドポイント疎通                 | `bruno/`                     | 必要                          |

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
- [ ] **Phase 7**: **Cloudflare Workers 化**（本番デプロイ想定の最終段）
  - [x] **Step 1**: エントリ二系統化（`app/index.ts` → `app/index.node.ts` リネーム + `app/index.workers.ts` 新設 + 共通組立を `app/bootstrap.ts` に切出）
  - [x] **Step 2**: `wrangler.toml` 追加・`@cloudflare/workers-types` 導入・`wrangler` 4.88.0 + `pnpm wrangler:dev` / `wrangler:deploy` / `wrangler:tail` 整備（**`compatibility_flags = []` を維持し `nodejs_compat` に逃げない方針**）
  - [x] **Step 3**: 環境変数の移行（ローカル）— `.dev.vars` 導入 + `.dev.vars.example` 配布 + `.gitignore` 追記（`.dev.vars` / `.wrangler/`）
  - [x] **Step 4**: ロガー差し替え — pino 依存を `app/shared/infrastructure/node-pino-logger.ts` に隔離。`logger.ts` は `AppLogger` interface + `createWorkersLogger`（`console.log(JSON.stringify(...))` ベース）+ `createSilentLogger` のみ。Workers バンドルから pino を完全除去
  - [x] **Step 5**: jose JWKS fetch を `JwksFetcherProvider` で per-request DI 化。Workers 側は `caches.default` + `ctx.waitUntil` で SWR キャッシュ。Node 側は jose 内蔵キャッシュをそのまま使用
  - [x] **Step 6**: `wrangler dev` で `GET /health` / `GET /v1/cakes` 200 OK 確認（Hono + Supabase REST が Workers V8 Isolate 上で動作）。33 テスト / 250 テスト全緑、typecheck OK
  - [x] **Step 7**: Cloudflare アカウント取得 + Supabase Cloud プロジェクト作成 + `supabase db push`（4 マイグレーション適用）+ `wrangler secret put` ×3（URL / anon / service_role）+ `wrangler deploy` で初回本番デプロイ完了。`https://cake-shop-api.rzrhacympbmdkagoybba.workers.dev/health` / `/v1/cakes` 200 OK 確認（Workers V8 Isolate → Supabase Cloud REST の本番疎通成功）
  - [ ] **Step 8**: 環境分離（`wrangler.toml` の `[env.staging]` / `[env.production]` を埋める + 各 env への secret 登録）
  - [ ] **Step 9**: GitHub Actions（`cloudflare/wrangler-action@v3`）で自動デプロイ + Versioned Deployments（カナリア 10% → 100%）の体験

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

# --- Cloudflare Workers（Phase 7 で導入予定） ---

# Workers ローカル起動（V8 Isolate を再現する公式ツール）
pnpm wrangler dev

# 本番デプロイ
pnpm wrangler deploy

# シークレット登録（本番環境変数）
pnpm wrangler secret put SUPABASE_URL
pnpm wrangler secret put SUPABASE_ANON_KEY
pnpm wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# バージョン管理（カナリアリリース）
pnpm wrangler versions upload
pnpm wrangler versions deploy --percentage 10
pnpm wrangler rollback
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
