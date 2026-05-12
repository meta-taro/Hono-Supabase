-- =============================================================================
-- 0001_create_cakes_table.sql
--   cakes テーブルと共通トリガ関数 set_updated_at() を作成する。
--   set_updated_at() は customers / orders でも再利用するため public スキーマに置く。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 共通: updated_at 自動更新トリガ関数
--   どのテーブルでも before update で呼べる汎用関数。
--   create or replace なので将来の修正にも安全（同名で上書き）。
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  '汎用 updated_at 自動更新トリガ関数。各テーブルの before update で利用する。';

-- -----------------------------------------------------------------------------
-- cakes テーブル
--   domain/cake.ts の不変条件を CHECK 制約として DB にも持たせ、
--   アプリ層をバイパスした直接 INSERT でも壊れたデータが入らないよう二重防御する。
-- -----------------------------------------------------------------------------
create table public.cakes (
  id          uuid          primary key default gen_random_uuid(),
  name        varchar(100)  not null,
  price       integer       not null,
  stock       integer       not null,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint cakes_name_length_check
    check (char_length(name) between 1 and 100),

  constraint cakes_price_range_check
    check (price between 1 and 1000000),

  constraint cakes_stock_non_negative_check
    check (stock >= 0)
);

comment on table  public.cakes              is 'ケーキ商品マスタ';
comment on column public.cakes.id           is 'ケーキ ID（UUID v4 / DEFAULT で自動採番）';
comment on column public.cakes.name         is 'ケーキ名（1-100 文字）';
comment on column public.cakes.price        is '価格（円・整数 / 1-1,000,000）';
comment on column public.cakes.stock        is '在庫数（0 以上の整数）';
comment on column public.cakes.created_at   is '作成日時（UTC）';
comment on column public.cakes.updated_at   is '更新日時（UTC・トリガで自動更新）';

-- updated_at 自動更新トリガ
create trigger cakes_set_updated_at
  before update on public.cakes
  for each row
  execute function public.set_updated_at();

-- インデックス: 一覧表示で名前順ソートが入る想定
create index cakes_name_idx on public.cakes (name);

-- -----------------------------------------------------------------------------
-- Row Level Security
--   Phase 3 段階では SELECT のみ全公開（CLAUDE.md「cakes は全員参照可」）。
--   INSERT / UPDATE / DELETE のポリシーは Phase 6（管理者ロール導入時）に追加する。
--   それまでは service_role キーが RLS をバイパスするため infrastructure テストは通る。
-- -----------------------------------------------------------------------------
alter table public.cakes enable row level security;

create policy cakes_select_public on public.cakes
  for select
  to anon, authenticated
  using (true);
