import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { Env } from '@/shared/http/env';
import type { AppEnv, RequestModules } from '@/shared/http/request-context';
import { createAdminClient } from '@/shared/infrastructure/supabase';
import { CakeSupabaseRepository } from '@/modules/cakes/infrastructure/cake.supabase-repository';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { CustomerSupabaseRepository } from '@/modules/customers/infrastructure/customer.supabase-repository';
import { SupabaseCustomerAuthAdapter } from '@/modules/customers/infrastructure/supabase-customer-auth.adapter';
import { createListCustomersUseCase } from '@/modules/customers/application/list-customers.usecase';
import { createSignUpCustomerUseCase } from '@/modules/customers/application/sign-up-customer.usecase';
import { createCustomerController } from '@/modules/customers/presentation/customer.controller';
import { OrderSupabaseRepository } from '@/modules/orders/infrastructure/order.supabase-repository';
import { createPlaceOrderUseCase } from '@/modules/orders/application/place-order.usecase';
import { createGetOrderUseCase } from '@/modules/orders/application/get-order.usecase';
import { createListOrdersUseCase } from '@/modules/orders/application/list-orders.usecase';
import { createOrderController } from '@/modules/orders/presentation/order.controller';

// ---------------------------------------------------------------------------
// composition-root = アプリケーション全体の DI を組み立てる中心地。
//   ここでだけ「具象クラスのインスタンス化」が行われる。
//   本番経路で唯一 infrastructure の具象を import する場所。
//
// Phase 6 改定:
//   sb（Supabase クライアント）はリクエストごとに JWT が異なるため、
//   モジュール（Repository / UseCase / Controller）の組み立ては
//   per-request にしないと「他人の権限で動く」事故が起きうる。
//
//   → buildRequestModules(sb, deps) をミドルウェアから呼び、
//      c.var.modules に積む形にする。routes はそこから controller を取り出す。
// ---------------------------------------------------------------------------

export interface ModuleDeps {
  env: Env;
  logger: AppLogger;
}

// per-request の Bounded Context 別 Controller 集合を組み立てる。
// この関数は「sb が何の権限で動いているか」を意識しない（与えられたものを使うだけ）。
export const buildRequestModules = (sb: SupabaseClient, deps: ModuleDeps): RequestModules => {
  // cakes
  const cakeRepo = new CakeSupabaseRepository(sb);
  const cakes = createCakeController({
    listCakes: createListCakesUseCase(cakeRepo),
    createCake: createCreateCakeUseCase(cakeRepo, deps.logger),
  });

  // customers
  const customerRepo = new CustomerSupabaseRepository(sb);
  const customerAuth = new SupabaseCustomerAuthAdapter(sb);
  // Supabase のメール認証（auth.email.enable_confirmations）を導入するため。
  //   確認必須の設定だと auth.signUp() はセッションを返さない → リクエストの sb は anon のまま。
  //   サインアップ直後に「トリガが作った customers 行を authUserId で読み戻す」処理が RLS で
  //   弾かれてしまうので、サインアップ経路の customers 参照だけは RLS をバイパスする admin
  //   クライアント経由にする（公開リクエストだが、行作成直後のシステム読み戻しなので正当）。
  //   auth.signUp() 自体は公開 auth 操作なので anon の customerAuth のまま。
  const customerAdminRepo = new CustomerSupabaseRepository(createAdminClient(deps.env));
  const customers = createCustomerController({
    listCustomers: createListCustomersUseCase(customerRepo),
    signUpCustomer: createSignUpCustomerUseCase(customerAuth, customerAdminRepo, deps.logger),
  });

  // orders
  const orderRepo = new OrderSupabaseRepository(sb);
  const orders = createOrderController({
    placeOrder: createPlaceOrderUseCase(orderRepo, deps.logger),
    getOrder: createGetOrderUseCase(orderRepo),
    listOrders: createListOrdersUseCase(orderRepo),
    // authUserId → customers.id の解決は customers リポジトリを使う。
    // controller は port (ResolveCustomerId) のみに依存し、
    // customers コンテキストの中身（Customer Entity 等）は知らない。
    resolveCustomerId: async (authUserId) => {
      const customer = await customerRepo.findByAuthUserId(authUserId);
      return customer ? customer.id.value : null;
    },
  });

  return { cakes, customers, orders };
};

// per-request にモジュールを組み立てて c.var.modules に積むミドルウェア。
// auth + requestSupabase の後に通すこと。
//
// Phase 9 Step 1: c.get('logger') が req スコープロガー（requestId / method / path 付き）に
// 差し替わっていれば、その時点で UseCase / Repository に渡る logger も自動的に req スコープに
// 格上げされる。requestContextMiddleware を入れていない経路では deps.logger をそのまま使う。
export const createModulesMiddleware = (deps: ModuleDeps): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const sb = c.get('sb');
    const logger = c.get('logger') ?? deps.logger;
    c.set('modules', buildRequestModules(sb, { env: deps.env, logger }));
    await next();
  };
};
