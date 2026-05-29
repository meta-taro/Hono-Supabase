-- =============================================================================
-- Phase 11 Step 1: cakes 向けレビュー（口コミ）
-- =============================================================================
-- 目的:
--   ケーキに対するユーザーレビュー（rating 1-5 + title + body）を扱う。
--   - reviews テーブル: 投稿本体 + 集計反正規化（helpful_count / flag_count）
--   - review_stats(p_cake_id) 関数: 一覧 API で「平均 4.5 (123 件) + 星別分布」を 1 クエリで返す
--   - has_purchased(p_auth_user_id, p_cake_id) 関数: 投稿時の「購入済みバッジ」snapshot 判定
--
-- 投稿ライフサイクル:
--   - 新規投稿は status='published' で作成（既定）
--   - モデレーションで status='hidden' / 'removed' に遷移（Phase 11 Step 4 で実装）
--   - removed のレビューは「再投稿可」とみなす = 重複チェックの対象から外す
--
-- 重複投稿防止:
--   UNIQUE INDEX (cake_id, user_id) WHERE status != 'removed'
--   = 同一 user × 同一 cake は published / hidden で 1 件まで。
--   removed 状態は除外して再投稿を許す（モデレーションで消された後の再投稿を阻害しない）。
--
-- snapshot 設計（is_verified_purchaser）:
--   レビュー投稿時に「投稿時点で当該 cake を購入していたか」を判定して固定する。
--   後日 order がキャンセルされても、過去の真実（投稿時点では購入していた）は変えない。
--   判定そのものは has_purchased() に切り出し、UseCase 側の port（VerifiedPurchaserChecker）
--   経由で呼ぶ。
--
-- RLS:
--   - SELECT: published は誰でも / 自分のレビュー（status を問わず）は本人 / すべては admin
--   - INSERT: authenticated + user_id = auth.uid()
--   - UPDATE/DELETE: 本人 or admin
--   service_role はすべての policy をバイパスするので運用バッチ・トリガからは触れる。
-- -----------------------------------------------------------------------------

create table public.reviews (
  id                     uuid          primary key default gen_random_uuid(),
  cake_id                uuid          not null references public.cakes(id) on delete cascade,
  -- auth.users への FK。customers ではなく auth.users に直結することで、
  -- 「customers 行をまだ作っていない auth ユーザー」でもレビューが残せる設計余地を残す
  -- （Phase 11 では customers 行が必ずあるが、API 設計上は customers を経由しない）。
  user_id                uuid          not null references auth.users(id) on delete cascade,
  rating                 smallint      not null,
  title                  varchar(100)  not null,
  body                   varchar(2000) not null,
  status                 text          not null default 'published',
  -- 「購入済みバッジ」の snapshot。投稿時に has_purchased() で判定して固定する。
  is_verified_purchaser  boolean       not null default false,
  -- 反正規化カウンタ。Phase 11 Step 3 / 4 でトリガから増減する。
  helpful_count          integer       not null default 0,
  flag_count             integer       not null default 0,
  created_at             timestamptz   not null default now(),
  updated_at             timestamptz   not null default now(),

  constraint reviews_rating_range_check
    check (rating between 1 and 5),

  constraint reviews_title_length_check
    check (char_length(title) between 1 and 100),

  constraint reviews_body_length_check
    check (char_length(body) between 1 and 2000),

  constraint reviews_status_check
    check (status in ('published', 'hidden', 'removed')),

  constraint reviews_helpful_count_non_negative
    check (helpful_count >= 0),

  constraint reviews_flag_count_non_negative
    check (flag_count >= 0)
);

comment on table  public.reviews                       is 'ケーキレビュー（口コミ）';
comment on column public.reviews.id                    is 'レビュー ID（UUID v4 / DEFAULT で自動採番）';
comment on column public.reviews.cake_id               is 'レビュー対象ケーキ ID（cake 削除で cascade）';
comment on column public.reviews.user_id               is '投稿者の auth.users.id（ユーザー削除で cascade）';
comment on column public.reviews.rating                is '星評価（1-5 の整数）';
comment on column public.reviews.title                 is 'レビュータイトル（1-100 文字）';
comment on column public.reviews.body                  is 'レビュー本文（1-2000 文字）';
comment on column public.reviews.status                is '公開状態: published / hidden / removed';
comment on column public.reviews.is_verified_purchaser is '投稿時点で当該 cake を購入済みだったかの snapshot';
comment on column public.reviews.helpful_count         is '「役立った」投票数（反正規化、Phase 11 Step 3 でトリガ更新）';
comment on column public.reviews.flag_count            is '通報件数（反正規化、Phase 11 Step 4 でトリガ更新）';
comment on column public.reviews.created_at            is '作成日時（UTC）';
comment on column public.reviews.updated_at            is '更新日時（UTC・トリガで自動更新）';

create trigger reviews_set_updated_at
  before update on public.reviews
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 重複投稿防止: 同一 user × 同一 cake は published / hidden で 1 件まで
-- removed は除外して再投稿を許す（モデレーションで削除された後の再投稿を阻害しない）。
-- -----------------------------------------------------------------------------
create unique index reviews_active_uniq_idx
  on public.reviews (cake_id, user_id)
  where status <> 'removed';

-- -----------------------------------------------------------------------------
-- ソート用の部分インデックス（published のみ対象）
-- 一覧 API のキーセットページネーションが効くようカラム順を ORDER BY と一致させる。
-- -----------------------------------------------------------------------------

-- newest: created_at DESC, id DESC
create index reviews_cake_created_idx
  on public.reviews (cake_id, created_at desc, id desc)
  where status = 'published';

-- helpful: helpful_count DESC, created_at DESC, id DESC
create index reviews_cake_helpful_idx
  on public.reviews (cake_id, helpful_count desc, created_at desc, id desc)
  where status = 'published';

-- -----------------------------------------------------------------------------
-- review_stats(p_cake_id): 一覧 API 用の集計関数
--   返り値: jsonb { count, average, distribution: { "1".."5": n } }
--   - 0 件のとき average は null（クライアントが「まだ評価なし」を表現できるように）
--   - average は小数 2 桁丸め
--   - distribution は 1..5 すべてのキーを必ず返す（0 件の星も 0 で埋める）
--   security invoker: 呼び出しユーザーの RLS（published のみ可視）に従う。
-- -----------------------------------------------------------------------------
create or replace function public.review_stats(p_cake_id uuid)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  result jsonb;
begin
  with published as (
    select rating
      from public.reviews
     where cake_id = p_cake_id
       and status = 'published'
  ),
  agg as (
    select
      count(*)::integer                              as cnt,
      avg(rating)                                    as avg_rating,
      count(*) filter (where rating = 1)::integer    as r1,
      count(*) filter (where rating = 2)::integer    as r2,
      count(*) filter (where rating = 3)::integer    as r3,
      count(*) filter (where rating = 4)::integer    as r4,
      count(*) filter (where rating = 5)::integer    as r5
    from published
  )
  select jsonb_build_object(
    'count',   cnt,
    'average', case when cnt = 0 then null else round(avg_rating::numeric, 2) end,
    'distribution', jsonb_build_object('1', r1, '2', r2, '3', r3, '4', r4, '5', r5)
  )
  into result
  from agg;
  return result;
end;
$$;

comment on function public.review_stats(uuid) is
  'cake_id 単位の published レビュー集計（count / average / 星別 distribution）を 1 クエリで返す。';

-- -----------------------------------------------------------------------------
-- has_purchased(p_auth_user_id, p_cake_id): 購入実績判定
--   レビュー投稿時の「購入済みバッジ」snapshot 判定で使う。
--   PLACED 状態の order に当該 cake の order_item が 1 件でもあれば true。
--   security invoker: 呼び出しユーザー本人の orders のみが見えるため、
--   他人の購入実績を漏洩することはない。
-- -----------------------------------------------------------------------------
create or replace function public.has_purchased(
  p_auth_user_id uuid,
  p_cake_id      uuid
)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1
      from public.order_items oi
      join public.orders      o on o.id = oi.order_id
      join public.customers   c on c.id = o.customer_id
     where oi.cake_id        = p_cake_id
       and c.auth_user_id    = p_auth_user_id
       and o.status          = 'PLACED'
  );
$$;

comment on function public.has_purchased(uuid, uuid) is
  '指定の auth ユーザーが指定の cake を購入済み（PLACED 状態）かを返す。レビュー投稿の verified_purchaser snapshot 判定で使用。';

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.reviews enable row level security;

-- 公開: 誰でも published のレビューは読める（口コミ閲覧は認証不要）
create policy reviews_select_published on public.reviews
  for select to anon, authenticated
  using (status = 'published');

-- 本人: 自分のレビューは status を問わず読める（モデレーションで hidden になっても見えるべき）
create policy reviews_select_self on public.reviews
  for select to authenticated
  using (auth.uid() = user_id);

-- 管理者: すべて読める（モデレーションのため）
create policy reviews_select_admin on public.reviews
  for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

-- INSERT: 認証済みユーザーが自分の user_id で投稿できる
create policy reviews_insert_self on public.reviews
  for insert to authenticated
  with check (auth.uid() = user_id);

-- UPDATE: 本人のみ（編集系は Phase 11 Step 1 のスコープ外だが、ポリシーは先に置いておく）
create policy reviews_update_self on public.reviews
  for update to authenticated
  using (auth.uid() = user_id);

-- DELETE: 本人のみ
create policy reviews_delete_self on public.reviews
  for delete to authenticated
  using (auth.uid() = user_id);

-- UPDATE/DELETE: 管理者はすべて編集・削除できる（モデレーション）
create policy reviews_update_admin on public.reviews
  for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

create policy reviews_delete_admin on public.reviews
  for delete to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
