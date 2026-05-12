import type { SupabaseClient } from '@supabase/supabase-js';
import type { CakeController } from '@/modules/cakes/presentation/cake.controller';
import type { CustomerController } from '@/modules/customers/presentation/customer.controller';
import type { OrderController } from '@/modules/orders/presentation/order.controller';

// ---------------------------------------------------------------------------
// リクエストごとに Hono の c.var に積む値を 1 ヵ所で型定義する。
//   - user:    認証済みユーザー情報（optional auth が JWT を検証してセット）
//   - sb:      このリクエストに紐づく Supabase クライアント
//              （未認証なら anon、認証済みなら anon + Authorization ヘッダ）
//   - jwt:     受信した生 JWT（必要時に Supabase 側へ転送するため保持）
//   - modules: per-request に組み立てた Bounded Context 別 Controller
//              composition-root の modulesMiddleware が sb から組み立てて積む
//
// `c.set('user', ...)` 経路は型安全にしたいため、Hono の Variables を拡張する形で公開する。
// 各 router / middleware は { Variables: AppVariables } を受けることで補完が効く。
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
}

export interface AppVariables {
  user?: AuthUser;
  sb: SupabaseClient;
  jwt?: string;
  modules: RequestModules;
}

export type AppEnv = { Variables: AppVariables };
