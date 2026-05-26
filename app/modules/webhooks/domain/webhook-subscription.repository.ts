import type { WebhookSubscription } from './webhook-subscription';

// ---------------------------------------------------------------------------
// WebhookSubscription Repository インターフェース（webhooks コンテキストの port）
//
//   実装は infrastructure 層（SupabaseWebhookSubscriptionRepository）に置く。
//   application 層からはこの interface だけに依存して具象を知らない。
//
//   listForPublish は EventPublisher が「アクティブな配信先一覧」を取るための専用 API。
//   list（管理 API 一覧）と分けているのは:
//     - publish 経路ではページネーション不要・全件即読み出しが望ましい
//     - list は管理者向けに secret を除外した shape を返すケースが将来出るかもしれない
// ---------------------------------------------------------------------------

export interface WebhookSubscriptionListCursor {
  createdAt: string;
  id: string;
}

export interface WebhookSubscriptionPage {
  subscriptions: WebhookSubscription[];
  nextCursor: WebhookSubscriptionListCursor | null;
}

export interface ListWebhookSubscriptionsParams {
  limit: number;
  after?: WebhookSubscriptionListCursor;
}

export interface CreateWebhookSubscriptionInput {
  url: string;
  secret: string;
  description?: string | null;
}

export interface WebhookSubscriptionRepository {
  create(input: CreateWebhookSubscriptionInput): Promise<WebhookSubscription>;
  findById(id: string): Promise<WebhookSubscription | null>;
  list(params: ListWebhookSubscriptionsParams): Promise<WebhookSubscriptionPage>;
  // EventPublisher 用: active=true の subscription を全件返す（ページネーションなし）。
  listForPublish(): Promise<WebhookSubscription[]>;
  delete(id: string): Promise<boolean>;
}
