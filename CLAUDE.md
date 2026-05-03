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
- **ランタイム非依存**: Hono が Web 標準ベースのため Node.js / Cloudflare Workers / Vercel Edge / Bun / Deno に展開可能。本リポでは Node.js 22 を採用
- **スコープ外**: フロントエンド実装・専用 SDK・IaC（フロントは別リポジトリで Next.js 想定）

### 学習ゴール

- DDD-lite による境界づけられたコンテキスト・レイヤ分離・依存方向の制御
- API バージョニング設計（`/v1` プレフィックス）
- `@hono/zod-openapi` による型安全な API 設計と OpenAPI 仕様の自動生成
- Supabase Auth + RLS（Row Level Security）によるアクセス制御
- pino による本番対応構造化ログ
- Vitest を使った TDD（テスト駆動開発）
- Docker + Supabase CLI による再現性ある開発環境

---

## Tech Stack（決定済み）

| カテゴリ | 技術 | バージョン | 選定理由 |
|---------|------|-----------|---------|
| Runtime | Node.js | 22 LTS | Active LTS。安定性とモダン機能のバランス最良 |
| Framework | Hono | ^4.x | 軽量・高速・型安全。Edge/Node 両対応 |
| OpenAPI | @hono/zod-openapi | ^0.x | Zod スキーマから OpenAPI 仕様を自動生成。二重管理不要 |
| Validation | Zod | ^3.x | TypeScript ネイティブのスキーマバリデーション |
| Database | Supabase (PostgreSQL 15) | — | Auth + RLS + リアルタイム込みの BaaS |
| DB Client | @supabase/supabase-js | ^2.x | Supabase 公式クライアント |
| Logger | pino + pino-pretty | ^9.x | 本番対応の構造化 JSON ログ。障害対応・QA 対応が可能なレベル |
| Test | Vitest | ^3.x | Vite ベース。高速・ESM ネイティブ・型安全 |
| Package Mgr | pnpm | ^9.x | 高速・ディスク効率・モノレポ対応。業界採用急増中 |
| Container | Docker Compose | — | アプリコンテナのみ管理。Supabase は CLI に任せる |
| Supabase Dev | Supabase CLI | latest | ローカル環境・マイグレーション管理の公式ツール |

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

| パターン | 採用 | 適用場所 |
|---|---|---|
| Aggregate / Entity | ✅ | 各コンテキストの `domain/` |
| Value Object | ✅（要所のみ） | `Price`, `OrderQuantity`, `Email` |
| Repository（interface + 実装） | ✅ 必須 | interface = `domain/`、実装 = `infrastructure/` |
| UseCase（Application Service） | ✅ 必須 | 1 ユースケース = 1 ファイル |
| Domain Event | ✅ 1 箇所 | `OrderPlaced` で在庫減算（Phase 5） |
| Domain Service | △ 必要時 | 跨る計算（合計金額算出など） |
| CQRS | ❌ | 規模に対して過剰 |
| Specification パターン | ❌ | 同上 |

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
    "details": [
      { "field": "price", "message": "0より大きい整数を指定してください" }
    ]
  }
}
```

| HTTP Status | Error Code | 意味 |
|-------------|-----------|------|
| 400 | `VALIDATION_ERROR` | Zod バリデーション失敗 |
| 401 | `UNAUTHORIZED` | 認証トークン不正または未提供 |
| 403 | `FORBIDDEN` | 権限なし（RLS ポリシー違反） |
| 404 | `NOT_FOUND` | 指定リソースが存在しない |
| 409 | `CONFLICT` | 一意制約違反（メール重複等） |
| 500 | `INTERNAL_SERVER_ERROR` | 予期しないサーバーエラー |

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

| 対象 | 規則 | 例 |
|------|------|----|
| ファイル | kebab-case + suffix | `cake.repository.ts`, `list-cakes.usecase.ts`, `price.vo.ts` |
| 関数・変数 | camelCase | `createCake`, `cakeId` |
| 型・クラス | PascalCase | `Cake`, `Price`, `NotFoundError` |
| 定数 | SCREAMING_SNAKE_CASE | `MAX_ORDER_QUANTITY` |
| DB テーブル・カラム | snake_case | `order_items`, `unit_price` |

#### ファイルサフィックス規約

| サフィックス | 配置先 | 役割 |
|---|---|---|
| `*.repository.ts` | `domain/` | Repository interface |
| `*.supabase-repository.ts` | `infrastructure/` | Repository 実装 |
| `*.usecase.ts` | `application/` | UseCase |
| `*.routes.ts` | `presentation/` | Hono ルート定義（OpenAPI 含む） |
| `*.controller.ts` | `presentation/` | Controller（入出力変換） |
| `*.dto.ts` | `presentation/` | Zod スキーマ（Request/Response） |
| `*.vo.ts` | `domain/` | Value Object |
| `*.errors.ts` | `domain/` | ドメイン例外 |

#### 永続化モデルの型命名規約（`domain` 多義使用の回避）

`domain` という語は **業務概念（Domain Model）専用** に予約する。infrastructure 層で DB 行を表す型は **`*Row` サフィックス** を付け、`infrastructure/domain/` のようなディレクトリは作らない。

| 種類 | レイヤ | 命名 | 例 | 振る舞い |
|---|---|---|---|---|
| Domain Model | `domain/` | サフィックスなし | `Cake`, `Price` | あり |
| Persistence Model | `infrastructure/`（ファイルローカル） | `*Row` | `CakeRow` | なし（データ構造のみ） |

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

| サフィックス | 用途 |
|---|---|
| `*Row` | RDB の 1 行（本プロジェクトの基本） |
| `*Schema` | テーブル構造定義 / Drizzle 等の Schema |
| `*State` | Aggregate の状態スナップショット（Vernon 流） |

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
import { Hono } from 'hono';                              // domain/ では NG

// ❌ コンテキスト間の直接参照（禁止）
import { Cake } from '@/modules/cakes/domain/cake';      // orders/ では NG
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

---

## Testing Strategy

### 方針: TDD（テスト駆動開発）

1. **RED**: 失敗するテストを書く
2. **GREEN**: テストが通る最小実装をする
3. **REFACTOR**: コードを整理する

### テスト分類と配置

| 種類 | 対象 | 配置 | DB |
|------|------|------|----|
| 単体（domain） | Entity / VO / Repository interface | 実装と共置（`*.test.ts`） | 不要 |
| 単体（application） | UseCase（in-memory repo で差し替え） | 実装と共置 | 不要 |
| 単体（infrastructure） | Repository 実装 | 実装と共置 | **必要**（Supabase ローカル） |
| 統合（presentation） | routes / controllers | `app/__tests__/integration/` | UseCase mock or 実 Supabase |
| 統合（shared 跨り） | error-handler 等 | `app/__tests__/integration/` | 不要 |
| E2E | 全エンドポイント疎通 | `bruno/` | 必要 |

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

## Logger Usage（pino）

障害対応・QA 対応ができるよう、構造化ログで文脈情報を残す。

```typescript
import { logger } from '@/shared/infrastructure/logger';

// ✅ 構造化ログ（JSON 形式。Datadog / CloudWatch で検索可能）
logger.info({ orderId, customerId }, 'Order created successfully');
logger.error({ err, orderId }, 'Failed to create order');
logger.warn({ userId, path: '/v1/orders' }, 'Unauthorized access attempt');

// ❌ console.log 禁止（コミット不可）
console.log('order created');
```

**ログを書く場所**: `application/` または `infrastructure/`（`domain/` は副作用ゼロを保つため不可）。

### ログレベル基準

| レベル | 使いどころ |
|--------|----------|
| `error` | 例外・障害（即時対応が必要） |
| `warn` | 異常だが処理は継続できる |
| `info` | 正常系のビジネスイベント（注文作成・顧客登録等） |
| `debug` | 開発時のデバッグ情報（本番は無効化） |

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
- [ ] **Phase 3**: `cakes` Bounded Context（domain → application → infrastructure → presentation の縦切り完成）
- [ ] **Phase 4**: `customers` Bounded Context（同構造）
- [ ] **Phase 5**: `orders` Bounded Context（Domain Event + Postgres Function でアトミック在庫減算）
- [ ] **Phase 6**: 認証（Supabase Auth + RLS + 認証ミドルウェア）+ OpenAPI 仕上げ

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

# Docker Compose（アプリのみ）
docker compose up -d
docker compose down
```

---

## Environment Variables

`.env.example` を参照。本番値は**絶対にコミットしない**。

| 変数名 | 説明 | 例 |
|--------|------|----|
| `SUPABASE_URL` | Supabase プロジェクト URL | `http://localhost:54321` |
| `SUPABASE_ANON_KEY` | 匿名キー（公開可・RLS で保護） | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | サービスロールキー（RLS バイパス・厳重管理） | `eyJ...` |
| `PORT` | サーバーポート | `3010` |
| `NODE_ENV` | 実行環境 | `development` / `production` / `test` |
| `LOG_LEVEL` | ログ出力レベル | `debug` / `info` / `warn` / `error` |
