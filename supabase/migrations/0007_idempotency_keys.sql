-- =============================================================================
-- Phase 10 Step 6: Idempotency-Key middleware の永続化テーブル
-- =============================================================================
-- 目的:
--   POST 系エンドポイント（注文作成・サインアップ・ケーキ登録）で「同じキー +
--   同じ body の再送 → 1 回目と同じレスポンスを replay」を保証する。
--   ネットワーク再送・クライアントリトライによる二重実行（重複注文等）を構造的に防ぐ。
--
-- スコーピング:
--   (key, owner_type, owner_id, scope) を複合主キーにする。
--     - 同じ key を別ユーザー（または別 IP）が使っても衝突しない（user vs ip 隔離）
--     - 同じユーザーが scope 違い（POST /v1/orders と POST /v1/customers）で
--       同じキーを使っても衝突しない（scope 隔離）
--   これにより、クライアント側のキー設計（UUID v4 等）に過度な前提を置かない。
--
-- ライフサイクル:
--   1. middleware が tryReserve(...) を呼んで status='in_progress' で INSERT
--   2. ハンドラ実行 → middleware が complete(...) で response_{status,body} と
--      status='completed' に UPDATE
--   3. 24h で expires_at 経過 → 同じキーは新規 INSERT として扱える（expired 上書き）
--
-- RLS:
--   明示ポリシーを置かない = service_role でしかアクセスできない。
--   業務 RLS（anon/authenticated）はこのテーブルに触れないため、
--   middleware は composition-root から admin client を受け取って読み書きする。
--
-- 物理削除:
--   pg_cron 等での expired 行の TRUNCATE は今回はやらない（学習用 DB は規模が小さい）。
--   行数が膨らんできたら Phase 10 のフォローアップで cron / TTL を入れる。
-- -----------------------------------------------------------------------------

create table public.idempotency_keys (
  key             text not null,
  owner_type      text not null check (owner_type in ('user', 'ip')),
  owner_id        text not null,
  scope           text not null,
  request_hash    text not null,
  status          text not null check (status in ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  expires_at      timestamptz not null default now() + interval '24 hours',
  primary key (key, owner_type, owner_id, scope)
);

comment on table public.idempotency_keys is
  'Idempotency-Key middleware の永続化テーブル。同じ key + 同じ body の再送を replay する。';

-- expires_at で expired 行を検索するためのインデックス（middleware の expired 検出経路）。
create index idempotency_keys_expires_idx
  on public.idempotency_keys (expires_at);

alter table public.idempotency_keys enable row level security;
-- 明示ポリシーなし = service_role のみアクセス可。
