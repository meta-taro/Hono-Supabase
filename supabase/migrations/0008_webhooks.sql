-- =============================================================================
-- Phase 10 Step 7: Webhook 配信パイプライン
-- =============================================================================
-- 目的:
--   ドメインイベント（OrderPlaced 等）を外部 URL に push する仕組みを構築する。
--   - webhook_subscriptions: 配信先 URL と HMAC-SHA256 鍵を保持
--   - webhook_deliveries:    1 イベント × 1 配信先の試行ログ（pending → succeeded/failed/dead）
--
-- スコーピング:
--   1 イベント（event_id）に対して N 個の subscription 行が一斉に作られる。
--   UNIQUE (event_id, subscription_id) で「同じ event を同じ subscription に二重発火」しない。
--   これは event publisher が再実行されても deliveries が増殖しないための構造的保証。
--
-- 配信ライフサイクル:
--   1. event publisher が active subscription を SELECT して deliveries を pending で INSERT
--   2. dispatcher が fetch(url) で配信
--      - 2xx/3xx → status='succeeded', succeeded_at=now()
--      - >=4xx / 例外 / タイムアウト → status='failed', attempts++, next_retry_at=指数バックオフ
--      - 6 回目失敗 → status='dead', next_retry_at=NULL（恒久停止）
--   3. リクエスト駆動の dispatch middleware が pending/failed で next_retry_at<=now() を拾って再試行
--
-- RLS:
--   明示ポリシーを置かない = service_role でのみアクセスできる。
--   公開リポジトリの安全性 + 管理 API は admin client 経由で操作する設計に合わせる。
--
-- 公開リポジトリ運用前提:
--   seed.sql / seed.staging.sql には subscription を入れない。
--   webhook_subscriptions が 0 件 = 配信 0 件 = フォーク者がそのまま使っても外部 URL を叩かない。
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- webhook_subscriptions: 配信先設定（URL + HMAC 鍵）
-- -----------------------------------------------------------------------------
create table public.webhook_subscriptions (
  id          uuid        primary key default gen_random_uuid(),
  url         text        not null,
  -- HMAC-SHA256 鍵。INSERT 時にアプリ側で生成し、レスポンスでも 1 度だけ返す（再表示不可）。
  secret      text        not null,
  description text,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint webhook_subscriptions_url_length_check
    check (char_length(url) between 1 and 2048),

  constraint webhook_subscriptions_secret_length_check
    check (char_length(secret) between 32 and 256)
);

comment on table  public.webhook_subscriptions              is 'Webhook 配信先サブスクリプション';
comment on column public.webhook_subscriptions.id           is 'サブスクリプション ID（UUID v4）';
comment on column public.webhook_subscriptions.url          is '配信先 URL（HTTPS 推奨。1-2048 文字）';
comment on column public.webhook_subscriptions.secret       is 'HMAC-SHA256 鍵（INSERT 時にアプリで生成、登録時のみレスポンスで開示）';
comment on column public.webhook_subscriptions.description  is '管理者向けメモ（自由記述・任意）';
comment on column public.webhook_subscriptions.active       is '有効フラグ（false で停止）';
comment on column public.webhook_subscriptions.created_at   is '作成日時（UTC）';
comment on column public.webhook_subscriptions.updated_at   is '更新日時（UTC・トリガで自動更新）';

create trigger webhook_subscriptions_set_updated_at
  before update on public.webhook_subscriptions
  for each row
  execute function public.set_updated_at();

-- アクティブな配信先だけを一覧スキャンするケース（event publisher）が多いので部分インデックス。
create index webhook_subscriptions_active_idx
  on public.webhook_subscriptions (created_at desc)
  where active = true;

-- -----------------------------------------------------------------------------
-- webhook_deliveries: 配信試行レコード（1 イベント × 1 配信先）
-- -----------------------------------------------------------------------------
create table public.webhook_deliveries (
  id              uuid        primary key default gen_random_uuid(),
  -- 同一イベントに対する subscription × event の二重発火を防ぐためのキー。
  -- ドメインイベントの一意 ID（uuid v4）をそのまま埋める。
  event_id        uuid        not null,
  subscription_id uuid        not null references public.webhook_subscriptions(id) on delete cascade,
  event_type      text        not null,
  payload         jsonb       not null,
  status          text        not null check (status in ('pending', 'succeeded', 'failed', 'dead')),
  attempts        integer     not null default 0,
  last_error      text,
  next_retry_at   timestamptz,
  succeeded_at    timestamptz,
  created_at      timestamptz not null default now(),

  unique (event_id, subscription_id)
);

comment on table  public.webhook_deliveries                 is 'Webhook 配信試行レコード（指数バックオフ retry 付き）';
comment on column public.webhook_deliveries.id              is '配信試行 ID（UUID v4）';
comment on column public.webhook_deliveries.event_id        is 'ドメインイベントの一意 ID（同 event × 同 subscription は UNIQUE 制約）';
comment on column public.webhook_deliveries.subscription_id is '配信先サブスクリプション ID（cascade delete）';
comment on column public.webhook_deliveries.event_type      is 'イベント種別（例: order.placed）';
comment on column public.webhook_deliveries.payload         is '配信ペイロード（イベント発火時に固定。retry でも同一）';
comment on column public.webhook_deliveries.status          is '状態: pending / succeeded / failed / dead';
comment on column public.webhook_deliveries.attempts        is '試行回数（成功/失敗を問わずインクリメント）';
comment on column public.webhook_deliveries.last_error      is '直近失敗時のエラーメッセージ（成功時は変更しない）';
comment on column public.webhook_deliveries.next_retry_at   is '次回 retry 予定時刻（dead/succeeded では NULL）';
comment on column public.webhook_deliveries.succeeded_at    is '配信成功時刻（UTC）';
comment on column public.webhook_deliveries.created_at      is '行作成日時（UTC）';

-- リクエスト駆動の dispatch loop が「retry 可能な配信を時刻順に拾う」ためのインデックス。
-- 部分インデックスにして pending/failed だけを対象にすれば、deliveries が増えても拾いコストは
-- 「retry 待ち」件数に対して線形のままに保てる。
create index webhook_deliveries_next_retry_idx
  on public.webhook_deliveries (next_retry_at)
  where status in ('pending', 'failed');

-- subscription 別の履歴一覧（管理 API の GET /v1/webhooks/subscriptions/:id/deliveries）用。
-- (subscription_id, created_at desc, id desc) で keyset ページネーションを効かせる。
create index webhook_deliveries_subscription_created_idx
  on public.webhook_deliveries (subscription_id, created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- Row Level Security
--   両テーブルとも明示ポリシーなし = service_role でのみアクセス可。
--   管理 API は admin client（SUPABASE_SERVICE_ROLE_KEY）経由で操作する設計。
-- -----------------------------------------------------------------------------
alter table public.webhook_subscriptions enable row level security;
alter table public.webhook_deliveries    enable row level security;
