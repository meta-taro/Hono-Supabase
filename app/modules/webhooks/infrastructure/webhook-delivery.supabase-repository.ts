import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebhookEvent } from '@/shared/domain/webhook-event';
import { WebhookDelivery, type WebhookDeliveryStatus } from '../domain/webhook-delivery';
import type {
  DueDelivery,
  EnqueueDeliveryInput,
  ListDeliveriesBySubscriptionParams,
  ListDueDeliveriesParams,
  MarkFailedInput,
  WebhookDeliveryPage,
  WebhookDeliveryRepository,
} from '../domain/webhook-delivery.repository';

// ---------------------------------------------------------------------------
// SupabaseWebhookDeliveryRepository
//
//   webhook_deliveries テーブル（migration 0008）への CRUD。
//   全アクセスは service_role 必須（RLS 明示ポリシーなし）。
//
//   特徴的な実装メモ:
//     - enqueue: INSERT に UNIQUE(event_id, subscription_id) 制約があり、衝突は null で返す。
//                これにより EventPublisher の再実行（リクエスト中断 + 再送）が二重発火に
//                ならない構造的保証を担う。
//     - listDue: 'pending' or 'failed' で next_retry_at <= now のものを取り出す。
//                結合先 webhook_subscriptions から url/secret も一緒に拾う（dispatcher が
//                その場で fetch するため）。
//     - markSucceeded/markFailed: dispatcher が結果を反映する write 操作。
// ---------------------------------------------------------------------------

const TABLE_NAME = 'webhook_deliveries';
const COLUMNS =
  'id, event_id, subscription_id, event_type, payload, status, attempts, last_error, next_retry_at, succeeded_at, created_at';

interface WebhookDeliveryRow {
  id: string;
  event_id: string;
  subscription_id: string;
  event_type: string;
  payload: WebhookEvent;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  succeeded_at: string | null;
  created_at: string;
}

const toEntity = (row: WebhookDeliveryRow): WebhookDelivery =>
  WebhookDelivery.reconstruct({
    id: row.id,
    eventId: row.event_id,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
    succeededAt: row.succeeded_at ? new Date(row.succeeded_at) : null,
    createdAt: new Date(row.created_at),
  });

// listDue の join 結果用。webhook_subscriptions の url/secret を埋め込みで取得する。
interface DueDeliveryRow extends WebhookDeliveryRow {
  webhook_subscriptions: {
    url: string;
    secret: string;
  } | null;
}

export class SupabaseWebhookDeliveryRepository implements WebhookDeliveryRepository {
  constructor(private readonly sb: SupabaseClient) {}

  async enqueue(input: EnqueueDeliveryInput): Promise<WebhookDelivery | null> {
    // ON CONFLICT DO NOTHING で衝突時は data=null。Supabase の upsert + ignoreDuplicates。
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .upsert(
        {
          event_id: input.event.event_id,
          subscription_id: input.subscriptionId,
          event_type: input.event.event_type,
          payload: input.event,
          status: 'pending',
          attempts: 0,
          next_retry_at: new Date().toISOString(),
        },
        { ignoreDuplicates: true, onConflict: 'event_id,subscription_id' },
      )
      .select(COLUMNS)
      .maybeSingle<WebhookDeliveryRow>();
    if (error) {
      throw new Error(`WebhookDelivery の enqueue に失敗しました: ${error.message}`);
    }
    return data ? toEntity(data) : null;
  }

  async listDue(params: ListDueDeliveriesParams): Promise<DueDelivery[]> {
    // PostgREST の embedded resource 機能で webhook_subscriptions(url, secret) を join。
    // active=true な subscription に紐づくものだけ取りたいが、subscription 単位で active
    // を切られた直後でも「すでに enqueue されていた pending は配信したい」運用も考えうるので
    // ここでは active フィルタを掛けない（subscription 削除時は cascade delete で消える）。
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(`${COLUMNS}, webhook_subscriptions(url, secret)`)
      .in('status', ['pending', 'failed'])
      .lte('next_retry_at', params.now.toISOString())
      .order('next_retry_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(params.limit)
      .overrideTypes<DueDeliveryRow[], { merge: false }>();
    if (error) {
      throw new Error(`WebhookDelivery 配信対象の取得に失敗しました: ${error.message}`);
    }
    const due: DueDelivery[] = [];
    for (const row of data) {
      // subscription が delete cascade で消えていれば webhook_subscriptions=null。
      // その場合は配信対象から外す（孤児行）。
      if (!row.webhook_subscriptions) continue;
      due.push({
        delivery: toEntity(row),
        url: row.webhook_subscriptions.url,
        secret: row.webhook_subscriptions.secret,
      });
    }
    return due;
  }

  async markSucceeded(deliveryId: string, succeededAt: Date): Promise<void> {
    const { error } = await this.sb
      .from(TABLE_NAME)
      .update({
        status: 'succeeded',
        succeeded_at: succeededAt.toISOString(),
        next_retry_at: null,
        last_error: null,
      })
      .eq('id', deliveryId);
    if (error) {
      throw new Error(`WebhookDelivery の成功反映に失敗しました: ${error.message}`);
    }
  }

  async markFailed(deliveryId: string, input: MarkFailedInput): Promise<void> {
    // attempts は DB 側で +1 する。.update で expression を渡せないため、atomic な
    // attempts++ を担保するには rpc を立てる手もあるが、本ユースケースは「dispatcher が
    // listDue で取った 1 行を直後に書き戻す」=「同一 delivery を並行で 2 つの worker が触る
    // 可能性が低い」ため、SELECT → UPDATE の競合は無視する。並行性が問題化したら
    // for update スキャンを担う RPC に置き換える。
    const { data: current, error: selectError } = await this.sb
      .from(TABLE_NAME)
      .select('attempts')
      .eq('id', deliveryId)
      .maybeSingle<{ attempts: number }>();
    if (selectError) {
      throw new Error(`WebhookDelivery の attempts 取得に失敗しました: ${selectError.message}`);
    }
    if (!current) {
      // 行が消えている（subscription 削除等）。何もせず終わる。
      return;
    }
    const newAttempts = current.attempts + 1;
    const newStatus: WebhookDeliveryStatus = input.nextRetryAt === null ? 'dead' : 'failed';
    const { error } = await this.sb
      .from(TABLE_NAME)
      .update({
        status: newStatus,
        attempts: newAttempts,
        last_error: input.errorMessage,
        next_retry_at: input.nextRetryAt ? input.nextRetryAt.toISOString() : null,
      })
      .eq('id', deliveryId);
    if (error) {
      throw new Error(`WebhookDelivery の失敗反映に失敗しました: ${error.message}`);
    }
  }

  async listBySubscription(
    params: ListDeliveriesBySubscriptionParams,
  ): Promise<WebhookDeliveryPage> {
    let query = this.sb
      .from(TABLE_NAME)
      .select(COLUMNS)
      .eq('subscription_id', params.subscriptionId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(params.limit + 1);

    if (params.after) {
      const ca = params.after.createdAt;
      const id = params.after.id;
      const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      query = query.or(`created_at.lt.${ca},and(created_at.eq.${ca},id.lt."${escapedId}")`);
    }

    const { data, error } = await query.overrideTypes<WebhookDeliveryRow[], { merge: false }>();
    if (error) {
      throw new Error(`WebhookDelivery 一覧の取得に失敗しました: ${error.message}`);
    }
    const rows = data;
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const deliveries = page.map(toEntity);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? { createdAt: last.created_at, id: last.id } : null;
    return { deliveries, nextCursor };
  }
}
