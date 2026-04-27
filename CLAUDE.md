# CLAUDE.md — Cake Shop Order API

このファイルは Claude Code（AIエージェント）向けのプロジェクト指示書です。
新しいマシン・セッションでもこのファイルを読めば即座に開発を再開できます。

---

## Project Overview

**目的**: Hono × Supabase を使った実務レベルの軽量バックエンド API を構築する学習サンプル  
**ドメイン**: ケーキ屋の商品・顧客・注文管理

### 学習ゴール

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

## Directory Structure

```
cake-shop-api/
├── app/                              # アプリケーションコード（全 TypeScript）
│   ├── index.ts                      # エントリーポイント（サーバー起動）
│   ├── app.ts                        # Hono インスタンス・ミドルウェア・ルートマウント
│   ├── routes/
│   │   └── v1/
│   │       ├── index.ts              # v1 ルーター集約
│   │       ├── cakes.routes.ts       # GET/POST /v1/cakes
│   │       ├── customers.routes.ts   # GET/POST /v1/customers
│   │       └── orders.routes.ts      # POST /v1/orders, GET /v1/orders/:id
│   ├── controllers/                  # リクエスト整形 → service 呼び出し → レスポンス整形（30行以内目安）
│   │   ├── cakes.controller.ts
│   │   ├── customers.controller.ts
│   │   └── orders.controller.ts
│   ├── services/                     # ビジネスロジック + DB アクセス（ここ以外で DB を触らない）
│   │   ├── cakes.service.ts
│   │   ├── customers.service.ts
│   │   └── orders.service.ts
│   ├── schemas/                      # Zod スキーマ（OpenAPI 定義 兼 バリデーション）
│   │   ├── cake.schema.ts
│   │   ├── customer.schema.ts
│   │   ├── order.schema.ts
│   │   └── common.schema.ts          # ErrorResponse, IdParam 等の共通スキーマ
│   ├── middleware/
│   │   └── auth.middleware.ts        # Supabase Auth JWT 検証
│   ├── lib/
│   │   ├── supabase.ts               # Supabase クライアントシングルトン
│   │   ├── logger.ts                 # pino ロガー（構造化ログ）
│   │   ├── errors.ts                 # AppError, NotFoundError 等のエラークラス
│   │   └── error-handler.ts          # app.onError 用グローバルハンドラ
│   └── types/
│       └── db.ts                     # DB 行の型定義（Cake, Customer, Order, OrderItem）
├── supabase/
│   ├── config.toml                   # Supabase CLI 設定
│   ├── migrations/                   # SQL マイグレーション（連番_説明.sql 形式）
│   │   ├── 0001_create_cakes.sql
│   │   ├── 0002_create_customers.sql
│   │   ├── 0003_create_orders.sql
│   │   ├── 0004_create_order_items.sql
│   │   └── 0005_add_indexes.sql
│   └── seed.sql                      # 開発用初期データ
├── bruno/                            # API テストコレクション（Bruno）
│   ├── environments/
│   │   └── local.bru
│   ├── Cakes/
│   ├── Customers/
│   └── Orders/
├── .claude/
│   └── settings.json                 # Claude Code プロジェクト設定（チーム共有）
├── CLAUDE.md                         # このファイル（AI エージェント指示書）
├── docker-compose.yml                # アプリ用（Supabase は CLI で別管理）
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
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
```

### 関数・ファイルサイズ

- 関数は **50 行以内**（超えたら分割を検討）
- ファイルは **800 行以内**（超えたらモジュール分割）
- ネストは **4 階層以内**（早期 return / guard clause を使う）
- Controller は **30 行以内**を目安（薄く保つ。ロジックは service へ）

### 命名規則

| 対象 | 規則 | 例 |
|------|------|----|
| ファイル | kebab-case | `cakes.service.ts` |
| 関数・変数 | camelCase | `createCake`, `cakeId` |
| 型・クラス | PascalCase | `CakeResponse`, `NotFoundError` |
| 定数 | SCREAMING_SNAKE_CASE | `MAX_ORDER_QUANTITY` |
| DB テーブル・カラム | snake_case | `order_items`, `unit_price` |

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
import { logger } from '@/lib/logger';
// 4. 相対パス
import { createCake } from './cakes.service';
```

---

## Forbidden Patterns（禁止パターン）

```typescript
// ❌ Controller / Route 内での直接 DB アクセス（禁止）
app.get('/v1/cakes', async (c) => {
  const { data } = await supabase.from('cakes').select('*');
  return c.json(data);
});

// ✅ 必ず service 経由でアクセスする
app.get('/v1/cakes', async (c) => {
  const cakes = await cakesService.listCakes();
  return c.json(cakes);
});
```

- 環境変数のハードコード禁止（必ず `.env` + `process.env` 経由）
- `console.log` のコミット禁止（`logger` を使う）
- マイグレーションファイルの**編集**禁止（新規追加のみ）
- `/v1` プレフィックスなしの業務エンドポイント追加禁止
- `any` 型の使用禁止

---

## Testing Strategy

### 方針: TDD（テスト駆動開発）

1. **RED**: 失敗するテストを書く
2. **GREEN**: テストが通る最小実装をする  
3. **REFACTOR**: コードを整理する

### テスト分類

| 種類 | ツール | 対象 | ディレクトリ |
|------|--------|------|------------|
| 単体テスト | Vitest | services, schemas, errors | `app/__tests__/unit/` |
| 統合テスト | Vitest + Hono test helper | routes, controllers | `app/__tests__/integration/` |
| E2E テスト | Bruno | 全エンドポイント疎通 | `bruno/` |

### カバレッジ目標

- **80% 以上必須**（`vitest.config.ts` で閾値を設定し、未達はビルドエラー扱い）

---

## Authentication（Supabase Auth）

### 方針

- Supabase Auth の JWT を使用（`Authorization: Bearer <token>` ヘッダ）
- `app/middleware/auth.middleware.ts` で JWT を検証し、`c.set('user', user)` でコンテキストに保存
- 認証不要なエンドポイント: `GET /health`, `POST /v1/customers`, `GET /v1/cakes`
- 認証必須なエンドポイント: それ以外すべて

### RLS（Row Level Security）

- `orders` テーブル: 本人のみ参照・作成可能
- `cakes` テーブル: 全員参照可。INSERT は管理者ロールのみ
- RLS ポリシーは `supabase/migrations/` に SQL で定義する

---

## Database Rules

- DB アクセスは **`app/services/` 配下のみ** に限定する
- マイグレーションは `supabase/migrations/NNNN_description.sql` 形式
- スキーマ変更は **新規マイグレーションファイルで追加**（既存ファイルの編集禁止）
- UUID は DB 側の `gen_random_uuid()` で生成（アプリ側で指定しない）
- タイムゾーンは **UTC** で統一（クライアント側で変換）
- `orders` 作成時の在庫減算は **Postgres Function** でトランザクション管理（アトミック保証）

---

## Logger Usage（pino）

障害対応・QA 対応ができるよう、構造化ログで文脈情報を残す。

```typescript
import { logger } from '@/lib/logger';

// ✅ 構造化ログ（JSON 形式。Datadog / CloudWatch で検索可能）
logger.info({ orderId, customerId }, 'Order created successfully');
logger.error({ err, orderId }, 'Failed to create order');
logger.warn({ userId, path: '/v1/orders' }, 'Unauthorized access attempt');

// ❌ console.log 禁止（コミット不可）
console.log('order created');
```

### ログレベル基準

| レベル | 使いどころ |
|--------|----------|
| `error` | 例外・障害（即時対応が必要） |
| `warn` | 異常だが処理は継続できる |
| `info` | 正常系のビジネスイベント（注文作成・顧客登録等） |
| `debug` | 開発時のデバッグ情報（本番は無効化） |

---

## Workflow for AI Agents（Claude Code 向け手順）

### 新機能追加

1. **CLAUDE.md を確認** → 規約・現フェーズ・禁止パターンをチェック
2. **planner agent** → 実装計画を立案
3. **tdd-guide agent** → テスト先行で実装（RED → GREEN → REFACTOR）
4. **code-reviewer agent** → コードレビュー
5. **security-reviewer agent** → 認証・DB アクセス変更時は必須

### DB 変更時の手順

1. 新規マイグレーション SQL を作成
2. `seed.sql` を必要に応じて更新
3. `app/types/db.ts` の型を更新
4. Zod スキーマを更新（`app/schemas/`）
5. サービス層を実装
6. OpenAPI 仕様は `@hono/zod-openapi` により自動反映される

### 実装順序（厳守）

```
Zod スキーマ → Controller → Service → Migration
```

---

## Implementation Progress（実装進捗）

> フェーズ完了時にチェックを入れてください

- [x] Phase 1: 設定ファイル群・プロジェクト初期化
- [ ] Phase 2: Hono アプリ骨格（Routes / Controllers / Services）
- [ ] Phase 3: Supabase マイグレーション + DB アクセス実装
- [ ] Phase 4: Zod バリデーション + エラーハンドリング統一
- [ ] Phase 5: `@hono/zod-openapi` による OpenAPI 自動生成
- [ ] Phase 6: Supabase Auth + RLS + 認証ミドルウェア

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
| `PORT` | サーバーポート | `3000` |
| `NODE_ENV` | 実行環境 | `development` / `production` |
| `LOG_LEVEL` | ログ出力レベル | `debug` / `info` |
