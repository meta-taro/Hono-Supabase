import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IdempotencyCompletePayload,
  IdempotencyRecord,
  IdempotencyStore,
  TryReserveOutcome,
} from './idempotency-store';

// ---------------------------------------------------------------------------
// SupabaseIdempotencyStore: idempotency_keys テーブルに対する実 Postgres 実装。
//
//   ライフサイクル:
//     1. tryReserve: INSERT ... ON CONFLICT DO NOTHING で「予約」を試みる。
//        - 挿入できた → inserted
//        - 衝突した   → SELECT で既存行を読み、expired / replay / in_progress / mismatch
//                       を判定。expired 行は DELETE して再 INSERT する（race は学習用
//                       規模では許容。pg_cron 等の物理削除は今回は導入しない）。
//     2. complete: UPDATE で response_{status, body} と status='completed' を書き戻す。
//        既に completed のエントリには触らない（最初の completed が勝つ）。
//
//   なぜ admin client（service_role）が必要か:
//     idempotency_keys は RLS 有効 + 明示ポリシーなし = service_role でのみアクセス可。
//     業務 anon/authenticated にこのテーブルを公開すると、key の存在有無を覗かれて
//     他人の操作タイミングが推測される副作用がある。composition-root が admin client を
//     注入する責務を負う。
//
//   ライブラリ依存:
//     PostgREST の upsert に ignoreDuplicates: true を渡すと
//     ON CONFLICT DO NOTHING RETURNING * 相当が得られる。SDK 経由でこの shape を
//     使うのが最小実装。
// ---------------------------------------------------------------------------

const TABLE_NAME = 'idempotency_keys';

interface IdempotencyRow {
  key: string;
  owner_type: string;
  owner_id: string;
  scope: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
  expires_at: string;
}

// PK 一致条件を全フィルタに適用するヘルパ（select / update / delete で共通）。
const applyPrimaryKey = <T extends { eq(col: string, value: unknown): T }>(
  query: T,
  r: IdempotencyRecord,
): T =>
  query
    .eq('key', r.key)
    .eq('owner_type', r.ownerType)
    .eq('owner_id', r.ownerId)
    .eq('scope', r.scope);

export class SupabaseIdempotencyStore implements IdempotencyStore {
  // sb は service_role キーで作った admin client を受け取る前提。
  // 業務 anon クライアントを渡すと RLS で全アクセスが弾かれる（=明示ポリシー無しのため）。
  constructor(private readonly sb: SupabaseClient) {}

  async tryReserve(record: IdempotencyRecord): Promise<TryReserveOutcome> {
    const insertedRow = await this.insertReservation(record);
    if (insertedRow) {
      return { kind: 'inserted' };
    }

    // 衝突 → 既存行を読んで状態判定。
    const existing = await this.selectExisting(record);
    if (!existing) {
      // 衝突直後に既存行が消えた（並行で expired 上書きが走った等）→ もう 1 回挿入を試す。
      const retry = await this.insertReservation(record);
      return retry ? { kind: 'inserted' } : { kind: 'in_progress' };
    }

    // expired 行は削除して再 INSERT を試みる。
    if (new Date(existing.expires_at).getTime() <= Date.now()) {
      await this.deleteExisting(record);
      const retry = await this.insertReservation(record);
      return retry ? { kind: 'inserted' } : { kind: 'in_progress' };
    }

    if (existing.request_hash !== record.requestHash) {
      return { kind: 'mismatch' };
    }

    if (existing.status === 'completed' && existing.response_status !== null) {
      return {
        kind: 'replay',
        status: existing.response_status,
        body: existing.response_body,
      };
    }

    return { kind: 'in_progress' };
  }

  async complete(record: IdempotencyRecord, payload: IdempotencyCompletePayload): Promise<void> {
    // status='in_progress' の行のみを completed に進める（最初の completed が勝つ）。
    // 既に completed の行に再書き込みすると response_body が壊れるので where で防御する。
    const query = this.sb
      .from(TABLE_NAME)
      .update({
        status: 'completed',
        response_status: payload.status,
        response_body: payload.body,
        completed_at: new Date().toISOString(),
      })
      .eq('status', 'in_progress');
    const { error } = await applyPrimaryKey(query, record);
    if (error) {
      throw new Error(`Idempotency 完了状態の保存に失敗しました: ${error.message}`);
    }
  }

  // ON CONFLICT DO NOTHING RETURNING * 相当。挿入できれば 1 行、衝突したら null を返す。
  private async insertReservation(record: IdempotencyRecord): Promise<IdempotencyRow | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .upsert(
        {
          key: record.key,
          owner_type: record.ownerType,
          owner_id: record.ownerId,
          scope: record.scope,
          request_hash: record.requestHash,
          status: 'in_progress',
        },
        { ignoreDuplicates: true, onConflict: 'key,owner_type,owner_id,scope' },
      )
      .select()
      .maybeSingle<IdempotencyRow>();

    if (error) {
      throw new Error(`Idempotency 予約の挿入に失敗しました: ${error.message}`);
    }
    return data;
  }

  private async selectExisting(record: IdempotencyRecord): Promise<IdempotencyRow | null> {
    const query = this.sb.from(TABLE_NAME).select('*');
    const { data, error } = await applyPrimaryKey(query, record).maybeSingle<IdempotencyRow>();
    if (error) {
      throw new Error(`Idempotency 既存行の取得に失敗しました: ${error.message}`);
    }
    return data;
  }

  private async deleteExisting(record: IdempotencyRecord): Promise<void> {
    const query = this.sb.from(TABLE_NAME).delete();
    const { error } = await applyPrimaryKey(query, record);
    if (error) {
      throw new Error(`Idempotency 期限切れ行の削除に失敗しました: ${error.message}`);
    }
  }
}
