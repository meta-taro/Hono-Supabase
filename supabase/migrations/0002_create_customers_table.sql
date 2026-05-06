-- =============================================================================
-- 0002_create_customers_table.sql
--   customers テーブルを作成する。
--   set_updated_at() は 0001 で作成済みのため再利用する（再定義しない）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- customers テーブル
--   domain/customer.ts と domain/email.vo.ts の不変条件を CHECK 制約として
--   DB にも持たせ、アプリ層をバイパスした直接 INSERT でも壊れたデータが
--   入らないよう二重防御する。
-- -----------------------------------------------------------------------------
create table public.customers (
  id          uuid          primary key default gen_random_uuid(),
  name        varchar(100)  not null,
  email       varchar(254)  not null,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint customers_name_length_check
    check (char_length(name) between 1 and 100),

  -- email は VO で trim + lowercase 済みの値が来る前提だが、
  -- DB 直挿入経路でも崩れないよう CHECK で「lowercase であること」「@ を含むこと」を担保する。
  -- 完璧な RFC 検証は不可能なので、明らかな不正のみ弾く。
  constraint customers_email_lowercase_check
    check (email = lower(email)),

  constraint customers_email_format_check
    check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),

  constraint customers_email_length_check
    check (char_length(email) between 3 and 254)
);

-- メールアドレスの一意制約。
-- VO で lowercase 化しているため、ここはシンプルな UNIQUE で十分
-- （UNIQUE INDEX (lower(email)) のような関数インデックスは不要）。
create unique index customers_email_unique_idx on public.customers (email);

comment on table  public.customers              is '顧客マスタ';
comment on column public.customers.id           is '顧客 ID（UUID v4 / DEFAULT で自動採番）';
comment on column public.customers.name         is '顧客名（1-100 文字）';
comment on column public.customers.email        is 'メールアドレス（lowercase 正規化済み・254 文字以内・UNIQUE）';
comment on column public.customers.created_at   is '作成日時（UTC）';
comment on column public.customers.updated_at   is '更新日時（UTC・トリガで自動更新）';

-- updated_at 自動更新トリガ
create trigger customers_set_updated_at
  before update on public.customers
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
--   Phase 4 段階のポリシー設計：
--     - INSERT は anon に許可（サインアップ相当の `POST /v1/customers` を認証不要で受ける）
--     - SELECT は authenticated のみ（一覧取得は管理者用途。Phase 6 で admin ロールに絞る）
--   service_role キーは RLS をバイパスするため、infrastructure テストはこのまま通る。
-- -----------------------------------------------------------------------------
alter table public.customers enable row level security;

-- サインアップは認証なしで通す。
-- 業務ルール上は重複検出 + 形式検証はアプリ + CHECK 制約で十分担保される。
create policy customers_insert_public on public.customers
  for insert
  to anon, authenticated
  with check (true);

-- 認証済みユーザのみ参照可。Phase 6 で「自分の顧客行のみ」または
-- 「admin ロールのみ」へさらに絞る予定。
create policy customers_select_authenticated on public.customers
  for select
  to authenticated
  using (true);
