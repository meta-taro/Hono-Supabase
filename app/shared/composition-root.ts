import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Logger } from 'pino';
import type { Env } from '@/shared/http/env';
import { createAdminClient } from '@/shared/infrastructure/supabase';
import { CakeSupabaseRepository } from '@/modules/cakes/infrastructure/cake.supabase-repository';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createCakeController } from '@/modules/cakes/presentation/cake.controller';
import { createCakeRouter } from '@/modules/cakes/presentation/cake.routes';

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

// アプリ全体の DI を 1 か所で組み立てる。
// 将来 customers / orders を追加するときは、ここに行を足すだけで済む。
export interface AppModules {
  cakesRouter: OpenAPIHono;
  // customersRouter: OpenAPIHono;  // Phase 4
  // ordersRouter: OpenAPIHono;     // Phase 5
}

export const buildAppModules = (deps: ModuleDeps): AppModules => ({
  cakesRouter: buildCakesModule(deps),
});
