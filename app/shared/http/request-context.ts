import type { SupabaseClient } from '@supabase/supabase-js';
import type { CakeController } from '@/modules/cakes/presentation/cake.controller';
import type { CustomerController } from '@/modules/customers/presentation/customer.controller';
import type { OrderController } from '@/modules/orders/presentation/order.controller';
import type { ReviewController } from '@/modules/reviews/presentation/review.controller';
import type { WebhookController } from '@/modules/webhooks/presentation/webhook.controller';
import type { AppLogger } from '@/shared/infrastructure/logger';

// ---------------------------------------------------------------------------
// リクエストごとに Hono の c.var に積む値を 1 ヵ所で型定義する。
//   - requestId: このリクエスト固有の ID（X-Request-Id を反射する元）
//   - logger:    requestId / method / path を child bindings に積んだ req スコープロガー
//                （Phase 9 Step 1 で導入。UseCase / error-handler がこれを使うことで、
//                障害発生時に「requestId=xxx で grep すれば 1 リクエスト分のログが追える」運用が成立）
//   - user:      認証済みユーザー情報（optional auth が JWT を検証してセット）
//   - sb:        このリクエストに紐づく Supabase クライアント
//                （未認証なら anon、認証済みなら anon + Authorization ヘッダ）
//   - jwt:       受信した生 JWT（必要時に Supabase 側へ転送するため保持）
//   - modules:   per-request に組み立てた Bounded Context 別 Controller
//                composition-root の modulesMiddleware が sb から組み立てて積む
//
// `c.set('user', ...)` 経路は型安全にしたいため、Hono の Variables を拡張する形で公開する。
// 各 router / middleware は { Variables: AppVariables } を受けることで補完が効く。
//
// requestId / logger を optional にしている理由:
//   `createApp()` を引数なしで呼ぶ最小構成（health.test.ts 互換）や、req-context
//   middleware を意図的に外したユニットテストでは未セットになりうる。型上 optional に
//   しておき、利用側（error-handler 等）で fallback を持つ実装にする。
// ---------------------------------------------------------------------------

export type AppRole = 'admin' | 'authenticated';

export interface AuthUser {
  // auth.users.id（Supabase Auth が発行する UUID）。
  // domain 内の CustomerId とは別物（auth と業務 DB のソース・オブ・トゥルース分離）。
  id: string;
  email?: string;
  // app_metadata.role の値。Supabase Studio から手動付与する運用。
  role: AppRole;
}

export interface RequestModules {
  cakes: CakeController;
  customers: CustomerController;
  orders: OrderController;
  // Phase 10 Step 7: Webhook 管理 API。webhook subscription の登録 / 一覧 / 削除 /
  //   配信履歴閲覧を扱う。すべて admin 専用。composition-root が per-request DI で
  //   admin Supabase client から組み立てて積む。
  webhooks: WebhookController;
  // Phase 11 Step 1: cakes 向けレビュー。投稿（POST）+ 一覧（GET）+ 集計。
  //   composition-root が per-request の sb から組み立てる。
  //   has_purchased RPC は security invoker なので、本人の JWT で呼ばれた sb を使うことで
  //   「他人の購入実績バッジを誤付与する」事故を構造的に防ぐ。
  reviews: ReviewController;
}

export interface AppVariables {
  requestId?: string;
  logger?: AppLogger;
  user?: AuthUser;
  sb: SupabaseClient;
  jwt?: string;
  modules: RequestModules;
}

export type AppEnv = { Variables: AppVariables };
