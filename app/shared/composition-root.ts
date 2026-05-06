import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Logger } from 'pino';
import type { Env } from '@/shared/http/env';
import { createAdminClient } from '@/shared/infrastructure/supabase';
import { CakeSupabaseRepository } from '@/modules/cakes/infrastructure/cake.supabase-repository';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';
import { CustomerSupabaseRepository } from '@/modules/customers/infrastructure/customer.supabase-repository';
import { createListCustomersUseCase } from '@/modules/customers/application/list-customers.usecase';
import { createCreateCustomerUseCase } from '@/modules/customers/application/create-customer.usecase';
import { createCustomerController } from '@/modules/customers/presentation/customer.controller';
import { createCustomerRouter } from '@/modules/customers/presentation/customer.routes';
import { OrderSupabaseRepository } from '@/modules/orders/infrastructure/order.supabase-repository';
import { createPlaceOrderUseCase } from '@/modules/orders/application/place-order.usecase';
import { createGetOrderUseCase } from '@/modules/orders/application/get-order.usecase';
import { createOrderController } from '@/modules/orders/presentation/order.controller';
import { createOrderRouter } from '@/modules/orders/presentation/order.routes';

// ---------------------------------------------------------------------------
// composition-root = アプリケーション全体の DI を組み立てる中心地。
//   ここでだけ「具象クラスのインスタンス化」が行われる。
//   本番経路で唯一 infrastructure の具象を import する場所。
//
// なぜ手動 DI なのか:
//   tsyringe / inversify などの DI コンテナは強力だが、学習が分岐するため不採用。
//   factory 関数の連鎖だけで十分（CLAUDE.md「DI 戦略」参照）。
//
// Phase 6 で変わる点:
//   現状は service_role キーで RLS をバイパスしている（認証ミドルウェア未実装のため）。
//   Phase 6 では「リクエストの JWT に基づく anon クライアント」をリクエストごとに
//   生成する形に変える（cakes module も含めて build を遅延化する設計に移行）。
// ---------------------------------------------------------------------------

export interface ModuleDeps {
  env: Env;
  logger: Logger;
}

// cakes Bounded Context を組み立てて Router を返す。
export const buildCakesModule = (deps: ModuleDeps): OpenAPIHono => {
  const sb = createAdminClient(deps.env);
  const repo = new CakeSupabaseRepository(sb);
  const listCakes = createListCakesUseCase(repo);
  const createCake = createCreateCakeUseCase(repo, deps.logger);
  const controller = createCakeController({ listCakes, createCake });
  return createCakeRouter(controller);
};

// customers Bounded Context を組み立てて Router を返す。
// 現状は service_role で組み立てる（Phase 6 で「sign-up は anon、list は authenticated」へ
// リクエストごとのクライアント切替に移行予定）。
export const buildCustomersModule = (deps: ModuleDeps): OpenAPIHono => {
  const sb = createAdminClient(deps.env);
  const repo = new CustomerSupabaseRepository(sb);
  const listCustomers = createListCustomersUseCase(repo);
  const createCustomer = createCreateCustomerUseCase(repo, deps.logger);
  const controller = createCustomerController({ listCustomers, createCustomer });
  return createCustomerRouter(controller);
};

// orders Bounded Context を組み立てて Router を返す。
// 注文確定（place_order RPC）は SECURITY DEFINER 関数で動くため、
// service_role でなくても Phase 6 移行時に anon でそのまま呼べる設計になっている。
export const buildOrdersModule = (deps: ModuleDeps): OpenAPIHono => {
  const sb = createAdminClient(deps.env);
  const repo = new OrderSupabaseRepository(sb);
  const placeOrder = createPlaceOrderUseCase(repo, deps.logger);
  const getOrder = createGetOrderUseCase(repo);
  const controller = createOrderController({ placeOrder, getOrder });
  return createOrderRouter(controller);
};

// アプリ全体の DI を 1 か所で組み立てる。
// 新しい Bounded Context を足すときは、ここに行を 1 つ追加するだけで済む。
export interface AppModules {
  cakesRouter: OpenAPIHono;
  customersRouter: OpenAPIHono;
  ordersRouter: OpenAPIHono;
}

export const buildAppModules = (deps: ModuleDeps): AppModules => ({
  cakesRouter: buildCakesModule(deps),
  customersRouter: buildCustomersModule(deps),
  ordersRouter: buildOrdersModule(deps),
});
