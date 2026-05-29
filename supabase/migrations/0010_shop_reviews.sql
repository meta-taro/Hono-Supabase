-- =============================================================================
-- Phase 11 Step 2: 店舗レビュー（口コミ）
-- =============================================================================
-- 目的:
--   「店舗そのもの」に対するユーザーレビュー（rating 1-5 + title + body）を扱う。
--   Step 1 の cakes 向け reviews とは別テーブル（shop_reviews）として独立させる。
--   - 本プロジェクトの店舗は単一（シングルトン）なので shop_id は持たない。
--     将来「複数店舗」になったら shop_id カラム + UNIQUE(shop_id, user_id) へ拡張する。
--   - shop_reviews テーブル: 投稿本体 + 集計反正規化（helpful_count / flag_count）
--   - shop_review_stats() 関数: 一覧 API で「平均 4.5 (123 件) + 星別分布」を 1 クエリで返す
--   - has_ordered(p_auth_user_id) 関数: 投稿時の「利用実績バッジ」snapshot 判定
--
-- なぜ reviews を再利用せず別テーブルにするか:
--   - reviews は cake_id NOT NULL なので「店舗そのもの」のレビューを乗せられない。
--   - cake_id を nullable にして両方を 1 テーブルに同居させると、UNIQUE / RLS / 集計の
--     条件分岐が増えて Step 1（本番投入済み）に回帰リスクが及ぶ。別テーブルなら影響ゼロ。
--   - ドメイン的にも「ケーキの口コミ」と「店舗の口コミ」は別 Aggregate。
--
-- snapshot 設計（is_verified_customer）:
--   レビュー投稿時に「投稿時点で当該ユーザーが利用実績（PLACED 注文）を持っていたか」を
--   判定して固定する。後日 order がキャンセルされても、過去の真実（投稿時点では利用客だった）
--   は変えない。Step 1 の is_verified_purchaser（cake 単位）と同じ snapshot 思想だが、
--   こちらは cake を問わず「何かしら注文したことがあるか」で判定する。
--   判定そのものは has_ordered() に切り出し、UseCase 側の port（OrderHistoryChecker）経由で呼ぶ。
--
-- 重複投稿防止:
--   UNIQUE INDEX (user_id) WHERE status != 'removed'
--   = 1 ユーザーにつき店舗レビューは published / hidden で 1 件まで。
--   removed 状態は除外して再投稿を許す（モデレーションで消された後の再投稿を阻害しない）。
--
-- RLS:
--   - SELECT: published は誰でも / 自分のレビュー（status を問わず）は本人 / すべては admin
--   - INSERT: authenticated + user_id = auth.uid()
--   - UPDATE/DELETE: 本人 or admin
--   service_role はすべての policy をバイパスするので運用バッチ・トリガからは触れる。
-- -----------------------------------------------------------------------------

create table public.shop_reviews (
  id                    uuid          primary key default gen_random_uuid(),
  -- auth.users への FK。customers ではなく auth.users に直結する（reviews と同じ理由）。
  user_id               uuid          not null references auth.users(id) on delete cascade,
  rating                smallint      not null,
  title                 varchar(100)  not null,
  body                  varchar(2000) not null,
  status                text          not null default 'published',
  -- 「利用実績バッジ」の snapshot。投稿時に has_ordered() で判定して固定する。
  is_verified_customer  boolean       not null default false,
  -- 反正規化カウンタ。Phase 11 Step 3 / 4 でトリガから増減する。
  helpful_count         integer       not null default 0,
  flag_count            integer       not null default 0,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint shop_reviews_rating_range_check
    check (rating between 1 and 5),

  constraint shop_reviews_title_length_check
    check (char_length(title) between 1 and 100),

  constraint shop_reviews_body_length_check
    check (char_length(body) between 1 and 2000),

  constraint shop_reviews_status_check
    check (status in ('published', 'hidden', 'removed')),

  constraint shop_reviews_helpful_count_non_negative
    check (helpful_count >= 0),

  constraint shop_reviews_flag_count_non_negative
    check (flag_count >= 0)
);

comment on table  public.shop_reviews                      is '店舗レビュー（単一店舗向け口コミ）';
comment on column public.shop_reviews.id                   is 'レビュー ID（UUID v4 / DEFAULT で自動採番）';
comment on column public.shop_reviews.user_id              is '投稿者の auth.users.id（ユーザー削除で cascade）';
comment on column public.shop_reviews.rating               is '星評価（1-5 の整数）';
comment on column public.shop_reviews.title                is 'レビュータイトル（1-100 文字）';
comment on column public.shop_reviews.body                 is 'レビュー本文（1-2000 文字）';
comment on column public.shop_reviews.status               is '公開状態: published / hidden / removed';
comment on column public.shop_reviews.is_verified_customer is '投稿時点で PLACED 注文の利用実績があったかの snapshot';
comment on column public.shop_reviews.helpful_count        is '「役立った」投票数（反正規化、Phase 11 Step 3 でトリガ更新）';
comment on column public.shop_reviews.flag_count           is '通報件数（反正規化、Phase 11 Step 4 でトリガ更新）';
comment on column public.shop_reviews.created_at           is '作成日時（UTC）';
comment on column public.shop_reviews.updated_at           is '更新日時（UTC・トリガで自動更新）';

create trigger shop_reviews_set_updated_at
  before update on public.shop_reviews
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 重複投稿防止: 1 ユーザーにつき published / hidden の店舗レビューは 1 件まで
-- removed は除外して再投稿を許す（モデレーションで削除された後の再投稿を阻害しない）。
-- -----------------------------------------------------------------------------
create unique index shop_reviews_active_uniq_idx
  on public.shop_reviews (user_id)
  where status <> 'removed';

-- -----------------------------------------------------------------------------
-- ソート用の部分インデックス（published のみ対象）
-- 一覧 API のキーセットページネーションが効くようカラム順を ORDER BY と一致させる。
-- reviews（cake 単位）と違い cake_id を含まないため先頭カラムから created_at / helpful_count。
-- -----------------------------------------------------------------------------

-- newest: created_at DESC, id DESC
create index shop_reviews_created_idx
  on public.shop_reviews (created_at desc, id desc)
  where status = 'published';

-- helpful: helpful_count DESC, created_at DESC, id DESC
create index shop_reviews_helpful_idx
  on public.shop_reviews (helpful_count desc, created_at desc, id desc)
  where status = 'published';

-- -----------------------------------------------------------------------------
-- shop_review_stats(): 一覧 API 用の集計関数（店舗全体・パラメータなし）
--   返り値: jsonb { count, average, distribution: { "1".."5": n } }
--   - 0 件のとき average は null（クライアントが「まだ評価なし」を表現できるように）
--   - average は小数 2 桁丸め
--   - distribution は 1..5 すべてのキーを必ず返す（0 件の星も 0 で埋める）
--   security invoker: 呼び出しユーザーの RLS（published のみ可視）に従う。
-- -----------------------------------------------------------------------------
create or replace function public.shop_review_stats()
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
      from public.shop_reviews
     where status = 'published'
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

comment on function public.shop_review_stats() is
  '店舗全体の published レビュー集計（count / average / 星別 distribution）を 1 クエリで返す。';

-- -----------------------------------------------------------------------------
-- has_ordered(p_auth_user_id): 利用実績判定
--   店舗レビュー投稿時の「利用実績バッジ」snapshot 判定で使う。
--   cake を問わず PLACED 状態の order が 1 件でもあれば true。
--   security invoker: 呼び出しユーザー本人の orders のみが見えるため、
--   他人の利用実績を漏洩することはない。
-- -----------------------------------------------------------------------------
create or replace function public.has_ordered(p_auth_user_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1
      from public.orders    o
      join public.customers c on c.id = o.customer_id
     where c.auth_user_id = p_auth_user_id
       and o.status       = 'PLACED'
  );
$$;

comment on function public.has_ordered(uuid) is
  '指定の auth ユーザーが PLACED 注文の利用実績を持つかを返す。店舗レビュー投稿の verified_customer snapshot 判定で使用。';

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.shop_reviews enable row level security;

-- 公開: 誰でも published のレビューは読める（口コミ閲覧は認証不要）
create policy shop_reviews_select_published on public.shop_reviews
  for select to anon, authenticated
  using (status = 'published');

-- 本人: 自分のレビューは status を問わず読める（モデレーションで hidden になっても見えるべき）
create policy shop_reviews_select_self on public.shop_reviews
  for select to authenticated
  using (auth.uid() = user_id);

-- 管理者: すべて読める（モデレーションのため）
create policy shop_reviews_select_admin on public.shop_reviews
  for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

-- INSERT: 認証済みユーザーが自分の user_id で投稿できる
create policy shop_reviews_insert_self on public.shop_reviews
  for insert to authenticated
  with check (auth.uid() = user_id);

-- UPDATE: 本人のみ（編集系は Phase 11 Step 2 のスコープ外だが、ポリシーは先に置いておく）
create policy shop_reviews_update_self on public.shop_reviews
  for update to authenticated
  using (auth.uid() = user_id);

-- DELETE: 本人のみ
create policy shop_reviews_delete_self on public.shop_reviews
  for delete to authenticated
  using (auth.uid() = user_id);

-- UPDATE/DELETE: 管理者はすべて編集・削除できる（モデレーション）
create policy shop_reviews_update_admin on public.shop_reviews
  for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

create policy shop_reviews_delete_admin on public.shop_reviews
  for delete to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');
