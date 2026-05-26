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
- **学習は基本ローカル Supabase 主体**: 日々の TDD・デバッグ・統合テストは `supabase start` のローカルコンテナで完結させる。Cloud 側（staging / production）は Phase 完了時のスモークテストや RLS / メール / OpenAPI の実機検証用で、Free Tier の auto-pause（7 日無アクティビティで停止）を受け入れて普段は寝かせる。pause されたら Dashboard で `Restore project`（数分・無料）。keep-alive 等の延命策は学習プロジェクトの趣旨に合わないので入れない。詳細は README「## クイックスタート」冒頭注記と「### Supabase 側の前提」末尾を参照
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

ディレクトリ構成の全体図と各レイヤの役割は **README.md「## ディレクトリ構成（DDD-lite）」** を参照。
ここでは AI agent が常に意識すべき**依存方向ルール**（上記「Architecture」節の「レイヤの役割と依存方向」）を絶対遵守すること。

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
GET  /v1/cakes/:id          # ケーキ詳細（認証不要・ETag 付き）
POST /v1/cakes              # ケーキ登録（要認証・管理者ロール）
PATCH /v1/cakes/:id         # 在庫更新（要認証・管理者ロール・楽観ロック / If-Match 必須）

GET  /v1/customers          # 顧客一覧（要認証・管理者ロール）
POST /v1/customers          # 顧客登録（認証不要・サインアップ相当）

POST /v1/orders             # 注文作成（要認証）
GET  /v1/orders             # 自分の注文一覧（要認証・本人のみ・カーソルページネーション）
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

| HTTP Status | Error Code                 | 意味                                                 |
| ----------- | -------------------------- | ---------------------------------------------------- |
| 400         | `VALIDATION_ERROR`         | Zod バリデーション失敗                               |
| 401         | `UNAUTHORIZED`             | 認証トークン不正または未提供                         |
| 403         | `FORBIDDEN`                | 権限なし（RLS ポリシー違反）                         |
| 404         | `NOT_FOUND`                | 指定リソースが存在しない                             |
| 409         | `CONFLICT`                 | 一意制約違反（メール重複等）                         |
| 412         | `PRECONDITION_FAILED`      | If-Match の版が不一致（楽観ロック競合）              |
| 428         | `PRECONDITION_REQUIRED`    | If-Match 未指定（条件付き更新が必須）                |
| 400         | `IDEMPOTENCY_KEY_REQUIRED` | `Idempotency-Key` ヘッダ未指定 / 形式不正            |
| 409         | `IDEMPOTENCY_IN_PROGRESS`  | 同じ `Idempotency-Key` の処理が進行中                |
| 422         | `IDEMPOTENCY_KEY_REUSED`   | 同じ `Idempotency-Key` で異なる body が送られた      |
| 429         | `RATE_LIMITED`             | リクエスト数が上限を超えた（`Retry-After` ヘッダ付） |
| 500         | `INTERNAL_SERVER_ERROR`    | 予期しないサーバーエラー                             |

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

> 各 Phase / Step の **詳細ログ・設計判断の根拠・実機で得た知見** は [docs/PROGRESS.md](docs/PROGRESS.md) に退避済み。CLAUDE.md には現フェーズと完了サマリのみ残す。

- [x] Phase 1: 設定ファイル群・プロジェクト初期化
- [x] Phase 2: Hono 骨格 + `/health` + 統一エラー + 構造化ログ + env 検証
- [x] Phase 2.5: DDD-lite 4 層構造への移行（`app/lib/` → `app/shared/`、`modules/{cakes,customers,orders}` 骨格）
- [x] Phase 3: `cakes` Bounded Context（4 層縦切り）
- [x] Phase 4: `customers` Bounded Context
- [x] Phase 5: `orders` Bounded Context（Domain Event + Postgres Function でアトミック在庫減算）
- [x] Phase 6: 認証（Supabase Auth + RLS + 認証ミドルウェア）+ OpenAPI 仕上げ
- [x] Phase 7: **Cloudflare Workers 化** — Workers / Node 二系統エントリ、Workers 互換ロガー、JWKS per-request DI、本番 + staging デプロイ、CI/CD（GitHub Actions + カナリア + rollback）
- [x] Phase 8（2026-05-14 完了）: **Supabase Auth メール運用** — `enable_confirmations = ON` 化、テンプレートのリポジトリ管理、確認後リダイレクト三層設計（README 別節）、Cloud 上の Custom SMTP（Resend）で実メール送信
- [x] Phase 9 (2026-05-20 完了): **観測・運用の質を上げる**
  - [x] Step 1 (2026-05-15): リクエスト ID 伝播 + リクエストスコープロガー（`request-context.middleware.ts`）
  - [x] Step 2 (2026-05-15): アクセスログミドルウェア（`access-log.middleware.ts`、ステータス別レベル分岐）
  - [x] Step 3a (2026-05-18): `/health` 3 状態化（ok / degraded / down、HTTP 200 / 200 / 503）
  - [x] Step 3b (2026-05-18): `/health` 閾値の実測すり合わせ — 3 シナリオ実機検証で `DEGRADED=800ms` / `TIMEOUT=1500ms` / stateless を全て据え置きで妥当と確認
  - [x] Step 4 (2026-05-18 実装 / 2026-05-20 デプロイ修正で正式クローズ): メトリクス収集（Workers Analytics Engine） — Free プランで SQL **読み出し** API が 403 のため、コード検証（300 テスト全緑）+ wrangler tail での本番データフロー目視確認でクローズ。route 正規化の SQL 直接検証は Paid 移行時のフォローアップに繰越。**注意**: AE バインディング追加後の staging CI 実デプロイが error 10089（AE 未有効化）で `f939de1`〜`456969b` の間ずっと失敗していたのを、当時 dry-run + 旧デプロイへの wrangler tail で検証したため見逃した。2026-05-20 に Dashboard で dataset 作成（=AE 有効化、Free で可能）→ 再デプロイで復旧。AE のナビ / dataset 作成は Free でも可（Paid 必須は SQL 読み出しのみ）。教訓: アカウント有効化を伴う変更は dry-run でなく CI 実デプロイ run の成否を必ず確認する
  - [x] Step 5 (2026-05-20): 観測・アラート — **Free プラン制約下で再定義してクローズ**。Logpush（=Workers Paid 必須）/ Slack webhook（=Pro 以上）が Free 枠外と裏取りできたため、`wrangler.toml` の `[observability]` 明示化（`head_sampling_rate`）+ 「わざと 5xx → Workers Logs を requestId/status/route で検索」体験 + Free 範囲のメール通知に再定義。Logpush 送出 / 5xx 率アラート / Slack 連携 / Step 4 の SQL 検証は Paid 移行時の繰越
- [x] Phase 10 (2026-05-26 完了): **API のリッチ化** — ページネーション / ソート・フィルタ / 検索 / 楽観ロック / Rate Limit / Idempotency-Key / Webhook 配信
  - [x] Step 1 (2026-05-20): **カーソルページネーション（`/v1/cakes`）** — keyset 方式。`(name, id)` 複合カーソルを base64url の不透明トークン化（UTF-8 は `TextEncoder`/`TextDecoder` 経由で Workers 互換）。`limit`（1〜100, 既定 20）+ `after` クエリ、`next_cursor`/`has_more` ボディ + RFC 5988 `Link` ヘッダ。改竄カーソルは `400 VALIDATION_ERROR`。汎用コーデックは `app/shared/http/cursor.ts`。詳細は README「`GET /v1/cakes` のページネーション仕様」
  - [x] Step 1.5 (2026-05-20): **カーソルページネーション（`/v1/orders`）** — RLS 保護付き `GET /v1/orders`（本人の注文のみ）を新設し Step 1 の cursor codec を再利用。`(placed_at, id)` 複合カーソルで新しい順（`placed_at DESC, id DESC`）。本人フィルタは多重防御（RLS `orders_select_self` + repository の明示 `customer_id` 絞り込み）で service_role 経路でも漏れない。`authUserId → customerId` は controller の `resolveCustomerId` ポート経由（未解決は `404`）。詳細は README「`GET /v1/orders` のページネーション仕様」
  - [x] Step 2 (2026-05-21): **ソート・フィルタ（`/v1/cakes`）** — `?sort=-price,name` 書式（`-` 降順・カンマ区切り多段、許可 name/price/stock、既定 name 昇順）を汎用パーサ `app/shared/http/sort.ts` に切り出し。フィルタは `available` / `min_price` / `max_price`（閉区間・`min>max` は `400`）/ `q`（name 部分一致 ILIKE）。キーセットを多段ソートに一般化（`(sortField1..N, id)` 複合キー、`id` を最終 tiebreaker）し PostgREST `.or()` の OR 展開でページ前進。**カーソルに正規化 sort 文字列を埋め込み**、次ページで sort 不一致なら `400`（フィルタは不透明トークンに含めない）。詳細は README「`GET /v1/cakes` のソート・フィルタ仕様」
  - [x] Step 3 (2026-05-21): **検索（`/v1/cakes`）** — `q` を `ILIKE` 部分一致から **PGroonga 全文検索**に置換（日本語の 2 文字・ひらがな部分一致を拾う）。`pg_trgm`（3 文字トライグラム最小・異表記別扱い）/ 標準 `tsvector`（日本語トークン分割不可）の弱点を言語化したうえで PGroonga 採用。PostgREST は演算子 `&@` を直接呼べないため `place_order` と同じく RPC（`search_cakes` 関数 = `supabase/migrations/0005_cakes_pgroonga_search.sql`、`security invoker`）に閉じ込め、検索 + フィルタ + 多段ソート + キーセットを動的 SQL（`%I` 識別子ホワイトリスト + `%L` 値で injection 防止）で処理。repository は `CakeFilter.nameSearch`（旧 `nameContains`）有無で RPC / 従来 PostgREST を分岐。in-memory は部分一致で近似し、実 DB 挙動は workers プールの実 Supabase テストで担保。Step 1/2 のキーセット維持・関連度ランキングなし。詳細は README「`GET /v1/cakes` のあいまい検索仕様」
  - [x] Step 4 (2026-05-22): **楽観ロック（`/v1/cakes/:id`）** — 在庫更新の lost update を `ETag` + 条件付きリクエストで防ぐ。`GET /v1/cakes/:id`（認証不要・`ETag: W/"<version>"` を返す）を新設、`PATCH /v1/cakes/:id`（管理者・stock 絶対値で冪等）に `If-Match` 必須。版は `cakes.version` 整数カラム + `BEFORE UPDATE` トリガ `bump_version()`（migration `0006_cakes_optimistic_lock.sql`）で単調増加し、`UPDATE … WHERE id=? AND version=?` の原子的更新で競合を検知。当初案 `409` ではなく **RFC 準拠の 412 PRECONDITION_FAILED（版不一致）/ 428 PRECONDITION_REQUIRED（If-Match 欠落）** を採用。Weak ETag コーデックは `app/shared/http/etag.ts`、`UpdateCakeStockUseCase` は findById（404 切り分け）→ updateStock（412）の二段。`GET /:id` は adminGuard 前に登録して public 維持。in-memory は version+1 でトリガを模し実 DB 競合は workers プールで担保。409 テスト全緑。詳細は README「`GET /v1/cakes/:id` + `PATCH /v1/cakes/:id` の楽観ロック仕様」
  - [x] Step 5 (2026-05-24): **Rate Limit（`/v1/*`）** — Cloudflare Workers の `[[ratelimits]]` binding を **3 本**（`LIMITER_PUBLIC_READ` 100/10s `ip` キー・`LIMITER_PUBLIC_WRITE` 5/60s `ip` キー・`LIMITER_AUTH_WRITE` 10/10s `user` キー）。binding の `limit()` は `{ success }` しか返さないため middleware factory（`buildRateLimitMiddlewares` in `bootstrap.ts`）が wrangler.toml の period から `Retry-After` を焼き込む。Hono の `router.use(path, mw)` はメソッドを区別しないので、`/` を共有する `GET /v1/cakes` / `POST /v1/cakes` のような衝突は **`restrictToMethods` ヘルパ**（`app/shared/http/rate-limit.middleware.ts`）でメソッド配列ゲートし、外側のメソッドは limiter を呼ばずに `next()` で素通し（カウンタ非消費）。`orders` は全パス authWrite を `router.use('*', ...)` 一発で適用。超過は **429 `RATE_LIMITED` + `Retry-After`**（統一エラー本文の `details[0].field='Retry-After'` にも同値）。binding 未注入時は `noopRateLimitMiddleware` で完全に外れる（Node ローカル / テスト最小経路に影響なし）。テストは node-unit プールで `InMemoryRateLimiter`（固定ウィンドウ + `now()` 差し替え）の middleware 単体 + 統合で「公開 GET が枯れても POST は影響しない」を検証（`pnpm verify` 緑 / 426 テスト）。**Workers binding 制約**: `period` は **`10s` / `60s` のみ**（長窓は Durable Object 等）。**テスト警告**: `@cloudflare/vitest-pool-workers@0.8.x` の bundled wrangler が古く `Unexpected fields found in top-level field: "ratelimits"` を吐くが、実デプロイは最新 wrangler が解釈するので無視可。詳細は README「`/v1/*` の Rate Limit 仕様」
  - [x] Step 6 (2026-05-25): **Idempotency-Key（`POST /v1/*`）** — 全 POST エンドポイント（`/v1/orders`・`/v1/cakes`・`/v1/customers`）で `Idempotency-Key` ヘッダを必須化し、再送による二重作成を Postgres 永続化で防ぐ。テーブル `idempotency_keys`（migration `0007_idempotency_keys.sql`）は複合主キー `(key, owner_type, owner_id, scope)` + `request_hash` + `status('in_progress'|'completed')` + `response_status / response_body` + `expires_at (default now()+24h)`、RLS 明示ポリシー無しで **service_role 専用**。port `IdempotencyStore`（`app/shared/infrastructure/idempotency-store.ts`）は 4 状態 union（`inserted`/`replay`/`in_progress`/`mismatch`）を返す `tryReserve` + `complete` の 2 メソッドで、Supabase 実装は PostgREST `.upsert(..., { ignoreDuplicates: true, onConflict: 'key,owner_type,owner_id,scope' })` で `INSERT … ON CONFLICT DO NOTHING` 相当を達成、衝突時のみ既存行を SELECT して expired/replay/in_progress/mismatch を判定（最初の completed が勝つ semantics）。middleware（`app/shared/http/idempotency.middleware.ts`）はヘッダ検証（**1〜255 文字・ASCII 印字可能のみ** = Stripe 流）→ body の **canonical JSON**（キー sort）+ Web Crypto SHA-256 で `request_hash` → `tryReserve` の 4 分岐：inserted は `next()` 後に `c.res.clone().json()` で response body を吸い出して `complete()`、replay は `c.newResponse(JSON.stringify(body), status)` で再現 + `Idempotency-Replayed: true` ヘッダ。owner は orders/cakes が **userOwner**（auth 後に user.id 確定）、customers が **ipOwner**（cf-connecting-ip）。失敗は **400 `IDEMPOTENCY_KEY_REQUIRED` / 409 `IDEMPOTENCY_IN_PROGRESS` / 422 `IDEMPOTENCY_KEY_REUSED`**（422 は Stripe 同様、構文は OK だが意味的に処理不能）。挿入順は `rate-limit → auth/admin guard → idempotency` で、auth 未通過は 401/403 が先に出て store を消費しない。route 側は `restrictToMethods(['POST'], deps.idempotency)` で同パス共有の GET 経路に副作用を出さない。store 未注入時は `noopIdempotencyMiddleware` で完全に外れる（テスト最小経路 / wrangler dev 未準備に影響なし）。詳細は README「`POST /v1/*` の Idempotency-Key 仕様」
  - [x] Step 7 (2026-05-26): **Webhook 配信** — 「注文確定」ドメインイベント `order.placed` を登録済みの外部 URL に POST。**HMAC-SHA256 署名（Stripe スタイル `X-Webhook-Signature: t=<unix>,v1=<hex>`、`signed_payload = "${t}.${raw_body}"` を Web Crypto `crypto.subtle.importKey + sign` で計算 = Workers 互換、`node:crypto` 非依存）** + **指数バックオフ retry スケジュール（attempts=1→1m, 2→5m, 3→30m, 4→4h, 5→24h, ≥MAX_ATTEMPTS=6→`dead`、合計猶予 ≒29h）**。`MAX_ATTEMPTS = 6`、`nextRetryDelayMs(attempts)` は domain の pure 関数（`app/modules/webhooks/domain/webhook-delivery.ts`）。**migration `0008_webhooks.sql`** = `webhook_subscriptions(url, secret(32-256文字), description, active, created_at, updated_at)` + `webhook_deliveries(event_id, subscription_id, event_type, payload jsonb, status('pending'|'succeeded'|'failed'|'dead'), attempts, last_error, next_retry_at, succeeded_at)`、**`UNIQUE(event_id, subscription_id)`** で event × subscription の二重発火を構造的に阻止、`webhook_deliveries.payload` が発火時 snapshot（retry でも同一）、部分インデックス `where status in ('pending','failed')` で retry 拾いコストを「待ち件数」に対して線形化、RLS は明示ポリシー無し = service_role 専用、`webhook_subscriptions` cascade delete で deliveries も消える。**`EventPublisher` 抽象**（`app/shared/application/event-publisher.ts`）+ **`WebhookDispatcher` port**（`app/shared/application/webhook-dispatcher.ts`）+ **`WebhookEvent` shared/domain DTO**（`app/shared/domain/webhook-event.ts`、`order.placed` union を後付け拡張可能に）で **orders → webhooks 直接 import を回避**（DDD-lite のコンテキスト跨ぎ禁止に準拠。`orders/domain/order-placed.event.ts` の `toOrderPlacedWebhookEvent(order)` が DTO 化担当）。**実装**: `FetchWebhookDispatcher`（`app/shared/infrastructure/webhook-dispatcher.ts`、`AbortController.abort()` で timeoutMs 打ち切り・2xx/3xx→succeeded・4xx/5xx→failed `HTTP <status>`・throw→failed 例外メッセージ・x-webhook-event-id/x-webhook-event-type ヘッダ付与、body は `JSON.stringify(event)` を **そのまま** 署名計算と fetch body の双方に流す = JSON キー順差で署名がズレない設計）/ `WebhookEventPublisher`（`app/shared/infrastructure/webhook-event-publisher.ts`、`listForPublish` で active=true sub を全件取得→ subscription ごとに `enqueue` を並列実行、1 件 throw しても **他 sub への enqueue は続行**＝部分失敗耐性、`listForPublish` 自体が落ちても publish は warn ログだけで throw しない＝主系を守る）/ `dispatchPendingDeliveries`（`app/shared/http/dispatch-pending-deliveries.ts`、`listDue({now, limit})` でキューを引いて配信→ 成功は `markSucceeded`、失敗は `markFailed({attempts, last_error, next_retry_at})` で `nextRetryDelayMs` の結果が `null` なら `status='dead'`）/ **`webhook-dispatch.middleware.ts`** = handler 完了後に `c.executionCtx.waitUntil(dispatchPendingDeliveries({limit:5}))` で次ラウンド進行（**hono `c.executionCtx` は未設定時に getter が throw する**ため try/catch でフォールバック必須、type は always-non-null だが実行時に未定義あり）。**Cron Triggers 未使用**＝ Workers Free プラン制約下で「リクエスト駆動」に倒した（トラフィック皆無時間帯では retry が止まる割り切り）。**webhooks コンテンツ**（`app/modules/webhooks/{domain,application,infrastructure,presentation}`）は DDD-lite 4 層完結、**管理 API 4 本** = `POST /v1/webhooks/subscriptions`（secret 1 度だけ返却・以降不可視）/ `GET /v1/webhooks/subscriptions`（keyset `created_at DESC, id DESC`）/ `DELETE /v1/webhooks/subscriptions/:id`（cascade）/ `GET /v1/webhooks/subscriptions/:id/deliveries`（履歴・`status`/`attempts`/`last_error`）、**admin 専用 + POST は Idempotency-Key 必須**（GET 系は対象外、`restrictToMethods(['POST'], idempotency)` ヘルパで分離、scope=`'POST /v1/webhooks/subscriptions'`）。**publish 失敗の握り**: `place-order.usecase` で `publisher.publish()` を try/catch + warn ログ＝副系の失敗が注文確定の成功を巻き戻さない（**多重防御**: publisher 実装側も throw しないが UseCase 側でも防御＝将来別実装の差し替え耐性）。`seed.sql` / `seed.staging.sql` には subscription を入れない＝公開リポジトリをそのまま叩いても外部 URL に意図せず HTTP リクエストを飛ばさない。**Workers 配線**: `index.workers.ts` で `webhookFetcher: globalThis.fetch.bind(globalThis)` を bootstrap に渡す→`buildWebhookSidecars` が `FetchWebhookDispatcher + WebhookEventPublisher + dispatchMiddleware` を **1 回だけ**組み立て（cold start 1 回コスト）、未注入時は `noopWebhookDispatchMiddleware` に倒して Node ローカル/最小テストでは完全に外れる。**テスト 518 件全緑** = HMAC（決定論・behavior 変化・generateWebhookSecret 64 hex）/ WebhookDelivery（指数バックオフ表）/ WebhookSubscription（URL スキーム・secret 長さ・reconstruct 再検証）/ FetchWebhookDispatcher（2xx/3xx/4xx/5xx/timeout/network throw・headers/body 全捕捉）/ WebhookEventPublisher（部分失敗耐性・listForPublish throw 時 warn）/ dispatchPendingDeliveries（5 状態遷移・dead 化・cascade 削除・limit cap）/ 4 ユースケース（register/list/delete/list-deliveries）+ **in-memory repo の wall-clock 罠**（`new Date()` で enqueue されるため test NOW を `new Date(Date.now()+60_000)` で算出しないと listDue で「未来から見て過去」にならず取れない）。詳細は README「`POST /v1/orders` → Webhook 配信仕様」

---

## Common Commands

主要コマンド（`pnpm dev` / `test` / `verify` / `wrangler:*` / `supabase` 系）は **README.md「## 主要コマンド」** に集約済み。新しいスクリプトを追加するときは README を真実の単一ソースとして更新する。

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
