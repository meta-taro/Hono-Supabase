import type { MiddlewareHandler } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppLogger } from '@/shared/infrastructure/logger';
import type { Env } from '@/shared/http/env';
import type { AppEnv, RequestModules } from '@/shared/http/request-context';
import type { EventPublisher } from '@/shared/application/event-publisher';
import { createAdminClient } from '@/shared/infrastructure/supabase';
import { CakeSupabaseRepository } from '@/modules/cakes/infrastructure/cake.supabase-repository';
import { createListCakesUseCase } from '@/modules/cakes/application/list-cakes.usecase';
import { createCreateCakeUseCase } from '@/modules/cakes/application/create-cake.usecase';
import { createGetCakeUseCase } from '@/modules/cakes/application/get-cake.usecase';
import { createUpdateCakeStockUseCase } from '@/modules/cakes/application/update-cake-stock.usecase';
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
import { SupabaseWebhookSubscriptionRepository } from '@/modules/webhooks/infrastructure/webhook-subscription.supabase-repository';
import { SupabaseWebhookDeliveryRepository } from '@/modules/webhooks/infrastructure/webhook-delivery.supabase-repository';
import { createRegisterSubscriptionUseCase } from '@/modules/webhooks/application/register-subscription.usecase';
import { createListSubscriptionsUseCase } from '@/modules/webhooks/application/list-subscriptions.usecase';
import { createDeleteSubscriptionUseCase } from '@/modules/webhooks/application/delete-subscription.usecase';
import { createListDeliveriesUseCase } from '@/modules/webhooks/application/list-deliveries.usecase';
import { createWebhookController } from '@/modules/webhooks/presentation/webhook.controller';
import { ReviewSupabaseRepository } from '@/modules/reviews/infrastructure/review.supabase-repository';
import { SupabaseVerifiedPurchaserChecker } from '@/modules/reviews/infrastructure/supabase-verified-purchaser.checker';
import { createListReviewsByCakeUseCase } from '@/modules/reviews/application/list-reviews-by-cake.usecase';
import { createPostReviewUseCase } from '@/modules/reviews/application/post-review.usecase';
import { createReviewController } from '@/modules/reviews/presentation/review.controller';
import { ShopReviewSupabaseRepository } from '@/modules/reviews/infrastructure/shop-review.supabase-repository';
import { SupabaseOrderHistoryChecker } from '@/modules/reviews/infrastructure/supabase-order-history.checker';
import { createListShopReviewsUseCase } from '@/modules/reviews/application/list-shop-reviews.usecase';
import { createPostShopReviewUseCase } from '@/modules/reviews/application/post-shop-review.usecase';
import { createShopReviewController } from '@/modules/reviews/presentation/shop-review.controller';

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
  // Phase 10 Step 7: ドメインイベントの publisher（注文確定で OrderPlaced を発行）。
  //   - bootstrap 側で WebhookEventPublisher（admin Supabase 経由で subscriptions / deliveries に書く）
  //     を 1 度だけ作って全リクエストで使い回す（cold start 1 回コスト）。
  //   - publisher 自体に Supabase client が閉じ込められているため、per-request ではなく
  //     アプリ起動時に組み立てる（subscription 一覧の取得は service_role でしか出来ない）。
  //   - テスト経路は NoopEventPublisher を渡せる。
  publisher: EventPublisher;
}

// per-request の Bounded Context 別 Controller 集合を組み立てる。
// この関数は「sb が何の権限で動いているか」を意識しない（与えられたものを使うだけ）。
export const buildRequestModules = (sb: SupabaseClient, deps: ModuleDeps): RequestModules => {
  // cakes
  const cakeRepo = new CakeSupabaseRepository(sb);
  const cakes = createCakeController({
    listCakes: createListCakesUseCase(cakeRepo),
    createCake: createCreateCakeUseCase(cakeRepo, deps.logger),
    getCake: createGetCakeUseCase(cakeRepo),
    updateCakeStock: createUpdateCakeStockUseCase(cakeRepo, deps.logger),
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
    placeOrder: createPlaceOrderUseCase(orderRepo, deps.logger, deps.publisher),
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

  // webhooks（管理 API は admin 専用 = service_role 必須）
  //   webhook_subscriptions / webhook_deliveries は RLS で明示ポリシーを置かず
  //   service_role 経路のみアクセス可。リクエストごとの user-sb（anon + JWT）では
  //   全クエリが空集合を返すため、admin Supabase client を per-request で組み立てる。
  //   customers の admin 経路と同じく、ここで作っても cold start 1 回分のコストではなく
  //   毎リクエスト 1 回作る形になるが、Supabase JS client は単なる薄い fetch wrapper
  //   なので無視できる（実通信は実際にメソッドが呼ばれたタイミングで発生）。
  const webhookAdminSb = createAdminClient(deps.env);
  const webhookSubscriptionRepo = new SupabaseWebhookSubscriptionRepository(webhookAdminSb);
  const webhookDeliveryRepo = new SupabaseWebhookDeliveryRepository(webhookAdminSb);
  const webhooks = createWebhookController({
    registerSubscription: createRegisterSubscriptionUseCase(webhookSubscriptionRepo, deps.logger),
    listSubscriptions: createListSubscriptionsUseCase(webhookSubscriptionRepo),
    deleteSubscription: createDeleteSubscriptionUseCase(webhookSubscriptionRepo, deps.logger),
    listDeliveries: createListDeliveriesUseCase(webhookSubscriptionRepo, webhookDeliveryRepo),
  });

  // reviews（cake 向け口コミ）
  //   - sb は per-request の anon / authenticated クライアント。
  //     公開 GET は anon でも reviews_select_published policy で読める。
  //     POST は authenticated + reviews_insert_self policy で本人のみ insert 可。
  //   - VerifiedPurchaserChecker は has_purchased RPC を本人 JWT で呼ぶことで
  //     「他人の購入実績バッジ誤付与」を構造的に防ぐ（security invoker + RLS）。
  const reviewRepo = new ReviewSupabaseRepository(sb);
  const verifiedPurchaserChecker = new SupabaseVerifiedPurchaserChecker(sb);
  const reviews = createReviewController({
    postReview: createPostReviewUseCase(reviewRepo, verifiedPurchaserChecker, deps.logger),
    listReviewsByCake: createListReviewsByCakeUseCase(reviewRepo),
  });

  // shopReviews（店舗向け口コミ・単一店舗）
  //   - reviews と同じく per-request の sb で組み立てる（公開 GET は anon・POST は本人）。
  //   - OrderHistoryChecker は has_ordered RPC を本人 JWT で呼ぶことで
  //     「他人の利用実績バッジ誤付与」を構造的に防ぐ（security invoker + RLS）。
  const shopReviewRepo = new ShopReviewSupabaseRepository(sb);
  const orderHistoryChecker = new SupabaseOrderHistoryChecker(sb);
  const shopReviews = createShopReviewController({
    postShopReview: createPostShopReviewUseCase(shopReviewRepo, orderHistoryChecker, deps.logger),
    listShopReviews: createListShopReviewsUseCase(shopReviewRepo),
  });

  return { cakes, customers, orders, webhooks, reviews, shopReviews };
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
    c.set('modules', buildRequestModules(sb, { env: deps.env, logger, publisher: deps.publisher }));
    await next();
  };
};
