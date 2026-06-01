-- =============================================================================
-- Phase 11 Step 3: レビューの「役立った」投票（helpful votes）
-- =============================================================================
-- 目的:
--   ケーキレビュー（reviews）と店舗レビュー（shop_reviews）の双方に対して、
--   ログインユーザーが「役立った」投票を付与/取消できるようにする。
--   - review_helpful_votes      テーブル: cake レビューへの投票
--   - shop_review_helpful_votes テーブル: 店舗レビューへの投票
--   投票数は各レビューの helpful_count（反正規化カウンタ）にトリガで反映する。
--
-- トグル設計（付与/取消の両対応）:
--   - POST   = 投票を付与（既に投票済みなら no-op で冪等）
--   - DELETE = 投票を取消（未投票なら no-op で冪等）
--   UNIQUE(user_id, review_id) により「1 ユーザー × 1 レビュー = 1 票」を構造的に保証する。
--   付与は INSERT ON CONFLICT DO NOTHING、取消は DELETE で表現する（どちらも自然に冪等）。
--
-- 自己投票の禁止:
--   「自分のレビューに役立った投票」を防ぐのはアプリ層（UseCase）の責務とする。
--   DB 制約で弾くこともできるが、投票テーブルからレビューの user_id を引く CHECK は
--   サブクエリを要し（CHECK ではサブクエリ不可）、トリガで弾くと 403 への変換が
--   煩雑になるため、ここでは UseCase 側で review.user_id と投票者を比較して 403 にする。
--
-- なぜカウンタトリガが SECURITY DEFINER なのか（重要）:
--   投票者は「他人のレビュー」に投票する。helpful_count は対象レビュー行（= 他人の行）の
--   UPDATE で進めるが、reviews / shop_reviews の UPDATE RLS ポリシーは
--   `auth.uid() = user_id`（本人のみ）。SECURITY INVOKER のままだと他人の行を更新できず、
--   RLS で 0 件更新になりカウンタが進まない。
--   そこでカウンタ保守トリガだけを SECURITY DEFINER（= 関数所有者 postgres 権限で実行・
--   RLS をバイパス）にして、誰のレビューでも helpful_count を正しく増減できるようにする。
--   search_path を空に固定し、参照オブジェクトはすべて public スキーマ修飾して
--   search_path 注入を防ぐ。
--
-- RLS:
--   - SELECT: 本人の票のみ / admin は全件（モデレーション・不正検知用）
--   - INSERT: authenticated + user_id = auth.uid()
--   - DELETE: 本人のみ
--   - UPDATE: 票は不変（付与か取消の二択）なので UPDATE ポリシーは置かない
--   service_role はすべての policy をバイパスするので運用バッチからは触れる。
-- -----------------------------------------------------------------------------

-- =============================================================================
-- 1. review_helpful_votes（cake レビューへの投票）
-- =============================================================================
create table public.review_helpful_votes (
  id          uuid        primary key default gen_random_uuid(),
  review_id   uuid        not null references public.reviews(id)  on delete cascade,
  user_id     uuid        not null references auth.users(id)      on delete cascade,
  created_at  timestamptz not null default now(),

  constraint review_helpful_votes_uniq unique (user_id, review_id)
);

comment on table  public.review_helpful_votes            is 'ケーキレビューへの「役立った」投票（1 ユーザー × 1 レビュー = 1 票）';
comment on column public.review_helpful_votes.review_id  is '投票対象レビュー ID（reviews 削除で cascade）';
comment on column public.review_helpful_votes.user_id    is '投票者の auth.users.id（ユーザー削除で cascade）';
comment on column public.review_helpful_votes.created_at is '投票日時（UTC）';

-- 取消（DELETE）と「投票済み判定」を (user_id, review_id) で引くため UNIQUE 制約が
-- そのままインデックスになる。レビュー削除 cascade のために review_id 単独索引も足す。
create index review_helpful_votes_review_idx
  on public.review_helpful_votes (review_id);

-- =============================================================================
-- 2. shop_review_helpful_votes（店舗レビューへの投票）
-- =============================================================================
create table public.shop_review_helpful_votes (
  id          uuid        primary key default gen_random_uuid(),
  review_id   uuid        not null references public.shop_reviews(id) on delete cascade,
  user_id     uuid        not null references auth.users(id)          on delete cascade,
  created_at  timestamptz not null default now(),

  constraint shop_review_helpful_votes_uniq unique (user_id, review_id)
);

comment on table  public.shop_review_helpful_votes            is '店舗レビューへの「役立った」投票（1 ユーザー × 1 レビュー = 1 票）';
comment on column public.shop_review_helpful_votes.review_id  is '投票対象レビュー ID（shop_reviews 削除で cascade）';
comment on column public.shop_review_helpful_votes.user_id    is '投票者の auth.users.id（ユーザー削除で cascade）';
comment on column public.shop_review_helpful_votes.created_at is '投票日時（UTC）';

create index shop_review_helpful_votes_review_idx
  on public.shop_review_helpful_votes (review_id);

-- =============================================================================
-- 3. カウンタ保守トリガ（SECURITY DEFINER で RLS をバイパス）
-- =============================================================================
-- AFTER INSERT で +1 / AFTER DELETE で -1。reviews.helpful_count を保守する。
-- helpful_count >= 0 の CHECK 制約が安全網。INSERT ON CONFLICT DO NOTHING で
-- 衝突した行は実際には INSERT されないためトリガは発火せず、二重カウントしない。
create or replace function public.bump_review_helpful_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT') then
    update public.reviews
       set helpful_count = helpful_count + 1
     where id = new.review_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update public.reviews
       set helpful_count = helpful_count - 1
     where id = old.review_id;
    return old;
  end if;
  return null;
end;
$$;

comment on function public.bump_review_helpful_count() is
  'review_helpful_votes の INSERT/DELETE に応じて reviews.helpful_count を増減する。SECURITY DEFINER で他人のレビュー行も RLS をバイパスして更新する。';

drop trigger if exists review_helpful_votes_count_trg on public.review_helpful_votes;
create trigger review_helpful_votes_count_trg
  after insert or delete on public.review_helpful_votes
  for each row
  execute function public.bump_review_helpful_count();

create or replace function public.bump_shop_review_helpful_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT') then
    update public.shop_reviews
       set helpful_count = helpful_count + 1
     where id = new.review_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update public.shop_reviews
       set helpful_count = helpful_count - 1
     where id = old.review_id;
    return old;
  end if;
  return null;
end;
$$;

comment on function public.bump_shop_review_helpful_count() is
  'shop_review_helpful_votes の INSERT/DELETE に応じて shop_reviews.helpful_count を増減する。SECURITY DEFINER で他人のレビュー行も RLS をバイパスして更新する。';

drop trigger if exists shop_review_helpful_votes_count_trg on public.shop_review_helpful_votes;
create trigger shop_review_helpful_votes_count_trg
  after insert or delete on public.shop_review_helpful_votes
  for each row
  execute function public.bump_shop_review_helpful_count();

-- =============================================================================
-- 4. Row Level Security
-- =============================================================================
alter table public.review_helpful_votes      enable row level security;
alter table public.shop_review_helpful_votes enable row level security;

-- review_helpful_votes -------------------------------------------------------
create policy review_helpful_votes_select_self on public.review_helpful_votes
  for select to authenticated
  using (auth.uid() = user_id);

create policy review_helpful_votes_select_admin on public.review_helpful_votes
  for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

create policy review_helpful_votes_insert_self on public.review_helpful_votes
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy review_helpful_votes_delete_self on public.review_helpful_votes
  for delete to authenticated
  using (auth.uid() = user_id);

-- shop_review_helpful_votes --------------------------------------------------
create policy shop_review_helpful_votes_select_self on public.shop_review_helpful_votes
  for select to authenticated
  using (auth.uid() = user_id);

create policy shop_review_helpful_votes_select_admin on public.shop_review_helpful_votes
  for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin');

create policy shop_review_helpful_votes_insert_self on public.shop_review_helpful_votes
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy shop_review_helpful_votes_delete_self on public.shop_review_helpful_votes
  for delete to authenticated
  using (auth.uid() = user_id);
