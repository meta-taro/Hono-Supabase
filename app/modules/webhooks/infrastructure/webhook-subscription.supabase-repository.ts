import type { SupabaseClient } from '@supabase/supabase-js';
import { WebhookSubscription } from '../domain/webhook-subscription';
import type {
  CreateWebhookSubscriptionInput,
  ListWebhookSubscriptionsParams,
  WebhookSubscriptionPage,
  WebhookSubscriptionRepository,
} from '../domain/webhook-subscription.repository';

// ---------------------------------------------------------------------------
// SupabaseWebhookSubscriptionRepository
//
//   webhook_subscriptions テーブル（migration 0008）への CRUD を担う。
//   RLS は明示ポリシーなし = service_role のみアクセス可。
//   composition-root が admin client（SUPABASE_SERVICE_ROLE_KEY 経由）を注入する責務を負う。
//
//   list（管理 API 用）と listForPublish（EventPublisher 用）の責務分離:
//     - list:           ページネーション付き。'created_at DESC, id DESC' のキーセットで前進
//     - listForPublish: active=true を全件即時返す（毎イベント 1 回呼ぶ前提なので
//                       ページネーションを挟まない。件数の実運用上限は数十〜数百想定）
// ---------------------------------------------------------------------------

const TABLE_NAME = 'webhook_subscriptions';
const COLUMNS = 'id, url, secret, description, active, created_at, updated_at';

interface WebhookSubscriptionRow {
  id: string;
  url: string;
  secret: string;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const toEntity = (row: WebhookSubscriptionRow): WebhookSubscription =>
  WebhookSubscription.reconstruct({
    id: row.id,
    url: row.url,
    secret: row.secret,
    description: row.description,
    active: row.active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });

export class SupabaseWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  constructor(private readonly sb: SupabaseClient) {}

  async create(input: CreateWebhookSubscriptionInput): Promise<WebhookSubscription> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .insert({
        url: input.url,
        secret: input.secret,
        description: input.description ?? null,
      })
      .select(COLUMNS)
      .single<WebhookSubscriptionRow>();
    if (error) {
      throw new Error(`WebhookSubscription の作成に失敗しました: ${error.message}`);
    }
    return toEntity(data);
  }

  async findById(id: string): Promise<WebhookSubscription | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(COLUMNS)
      .eq('id', id)
      .maybeSingle<WebhookSubscriptionRow>();
    if (error) {
      throw new Error(`WebhookSubscription の取得に失敗しました: ${error.message}`);
    }
    return data ? toEntity(data) : null;
  }

  async list(params: ListWebhookSubscriptionsParams): Promise<WebhookSubscriptionPage> {
    let query = this.sb
      .from(TABLE_NAME)
      .select(COLUMNS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(params.limit + 1);

    if (params.after) {
      // (created_at, id) DESC のキーセット条件: (created_at < cursor.created_at)
      //  OR (created_at = cursor.created_at AND id < cursor.id)
      const ca = params.after.createdAt;
      const id = params.after.id;
      const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      query = query.or(`created_at.lt.${ca},and(created_at.eq.${ca},id.lt."${escapedId}")`);
    }

    const { data, error } = await query.overrideTypes<WebhookSubscriptionRow[], { merge: false }>();
    if (error) {
      throw new Error(`WebhookSubscription 一覧の取得に失敗しました: ${error.message}`);
    }
    const rows = data;
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const subscriptions = page.map(toEntity);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? { createdAt: last.created_at, id: last.id } : null;
    return { subscriptions, nextCursor };
  }

  async listForPublish(): Promise<WebhookSubscription[]> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(COLUMNS)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .overrideTypes<WebhookSubscriptionRow[], { merge: false }>();
    if (error) {
      throw new Error(`WebhookSubscription（active）一覧の取得に失敗しました: ${error.message}`);
    }
    return data.map(toEntity);
  }

  async delete(id: string): Promise<boolean> {
    // 削除した行を返してもらうことで「実際に消えたか」を判定する（404 切り分け）。
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle<{ id: string }>();
    if (error) {
      throw new Error(`WebhookSubscription の削除に失敗しました: ${error.message}`);
    }
    return data !== null;
  }
}
