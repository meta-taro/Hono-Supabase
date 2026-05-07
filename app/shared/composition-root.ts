import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { Env } from '@/shared/http/env';
import type { AppEnv, RequestModules } from '@/shared/http/request-context';
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
  logger: Logger;
}

// per-request の Bounded Context 別 Controller 集合を組み立てる。
// この関数は「sb が何の権限で動いているか」を意識しない（与えられたものを使うだけ）。
export const buildRequestModules = (
  sb: SupabaseClient,
  deps: ModuleDeps,
): RequestModules => {
  // cakes
  const cakeRepo = new CakeSupabaseRepository(sb);
  const cakes = createCakeController({
    listCakes: createListCakesUseCase(cakeRepo),
    createCake: createCreateCakeUseCase(cakeRepo, deps.logger),
  });

  // customers
  const customerRepo = new CustomerSupabaseRepository(sb);
  const customerAuth = new SupabaseCustomerAuthAdapter(sb);
  const customers = createCustomerController({
    listCustomers: createListCustomersUseCase(customerRepo),
    signUpCustomer: createSignUpCustomerUseCase(
      customerAuth,
      customerRepo,
      deps.logger,
    ),
  });

  // orders
  const orderRepo = new OrderSupabaseRepository(sb);
  const orders = createOrderController({
    placeOrder: createPlaceOrderUseCase(orderRepo, deps.logger),
    getOrder: createGetOrderUseCase(orderRepo),
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
export const createModulesMiddleware = (
  deps: ModuleDeps,
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const sb = c.get('sb');
    c.set('modules', buildRequestModules(sb, deps));
    await next();
  };
};
