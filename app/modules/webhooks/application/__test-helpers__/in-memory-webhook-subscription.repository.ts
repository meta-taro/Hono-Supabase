import { WebhookSubscription } from '../../domain/webhook-subscription';
import type {
  CreateWebhookSubscriptionInput,
  ListWebhookSubscriptionsParams,
  WebhookSubscriptionPage,
  WebhookSubscriptionRepository,
} from '../../domain/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// テスト専用のメモリ実装。DDD-lite の利点で UseCase / Service を Supabase 抜きで叩ける。
//
//   キーセット並び順は実装と揃える: (created_at DESC, id DESC)。
//   id 生成は呼び出し側が任意で指定できる（テストで境界を狙うため）が、未指定なら
//   crypto.randomUUID で UUID v4 を採番する。
// ---------------------------------------------------------------------------

const compareDesc = (a: WebhookSubscription, b: WebhookSubscription): number => {
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return bt - at;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

export class InMemoryWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  private readonly store = new Map<string, WebhookSubscription>();
  private idCounter = 0;

  // テストセットアップ用の直接 seed（id / createdAt を固定して境界を狙う）。
  seed(sub: WebhookSubscription): void {
    this.store.set(sub.id, sub);
  }

  async create(input: CreateWebhookSubscriptionInput): Promise<WebhookSubscription> {
    this.idCounter += 1;
    // 決定的な UUID v4 形式の id を生成（テストでアサーションしやすいよう連番）。
    const id = `00000000-0000-4000-8000-${String(this.idCounter).padStart(12, '0')}`;
    const now = new Date();
    const sub = WebhookSubscription.create({
      id,
      url: input.url,
      secret: input.secret,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    });
    this.store.set(id, sub);
    return sub;
  }

  async findById(id: string): Promise<WebhookSubscription | null> {
    return this.store.get(id) ?? null;
  }

  async list(params: ListWebhookSubscriptionsParams): Promise<WebhookSubscriptionPage> {
    const sorted = [...this.store.values()].sort(compareDesc);
    const filtered = params.after
      ? sorted.filter((s) => {
          const ca = s.createdAt.toISOString();
          if (ca !== params.after?.createdAt) return ca < (params.after?.createdAt ?? '');
          return s.id < (params.after?.id ?? '');
        })
      : sorted;
    const hasMore = filtered.length > params.limit;
    const subscriptions = filtered.slice(0, params.limit);
    const last = subscriptions[subscriptions.length - 1];
    const nextCursor =
      hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null;
    return { subscriptions, nextCursor };
  }

  async listForPublish(): Promise<WebhookSubscription[]> {
    return [...this.store.values()].filter((s) => s.active).sort(compareDesc);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  // テストアサーション用のサイズ取得（インターフェース外）。
  size(): number {
    return this.store.size;
  }
}
