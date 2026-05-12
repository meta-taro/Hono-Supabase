-- =============================================================================
-- 0004_phase6_auth.sql
--   Phase 6: 認証 + RLS の本格運用への移行。
--
--   - customers に auth_user_id を追加して auth.users と FK で結ぶ（B-2 案：
--     UUID 自動採番は customers 側で残し、別カラムで auth.users にリンク）
--   - handle_new_user トリガで auth.users INSERT 時に customers 行を自動生成
--   - cakes / customers / orders / order_items の RLS ポリシーを Phase 6 仕様へ更新
--     （SELECT/INSERT/UPDATE/DELETE をきめ細かく制御）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- customers.auth_user_id
--   auth.users.id を保持する FK 列。1:1 関係（同じ auth ユーザーが
--   複数の customers 行を持たない）を UNIQUE で担保する。
--   ON DELETE CASCADE: auth ユーザーが削除されたら customers 行も消える。
--   学習用 DB なので nullable は許さない。既存の customers 行は seed のみ。
-- -----------------------------------------------------------------------------

-- 既存の seed データ（auth_user_id を持たない行）は Phase 6 で前提が変わるため、
-- まとめて削除してから列を追加する（学習用なので破壊変更を許す）。
delete from public.order_items;
delete from public.orders;
delete from public.customers;

alter table public.customers
  add column auth_user_id uuid not null
    references auth.users(id) on delete cascade;

create unique index customers_auth_user_id_unique_idx
  on public.customers (auth_user_id);

comment on column public.customers.auth_user_id is
  'auth.users.id への FK。サインアップ時の auth ユーザーと 1:1 で対応する。';

-- -----------------------------------------------------------------------------
-- handle_new_user: auth.users INSERT 時に customers 行を自動生成
--
--   なぜトリガ方式か:
--     - auth.users と customers の同時生成を「1 トランザクション内で」担保する
--     - signUp 後にアプリが個別に INSERT するとロールバック設計が複雑化する
--     - Supabase 公式チュートリアルが採用する慣用パターン
--
--   raw_user_meta_data->>'name' を読むため、サインアップ時に
--     supabase.auth.signUp({ email, password, options: { data: { name } } })
--   と name を載せる必要がある。
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.customers (auth_user_id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email)
  );
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'auth.users への INSERT に対して customers 行を 1:1 で自動生成するトリガ関数。';

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- =============================================================================
-- RLS ポリシー Phase 6 仕様
--   方針:
--     - 業務 API は anon キー + JWT（Authorization: Bearer ...）で動作する想定
--     - service_role は infrastructure テスト・トリガ関数でのみ使用
--     - admin ロール判定は JWT の app_metadata.role = 'admin' を見る
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cakes
--   - SELECT: 全員（anon/authenticated）— メニュー閲覧は認証不要
--   - INSERT/UPDATE/DELETE: app_metadata.role = 'admin' のみ
-- -----------------------------------------------------------------------------
drop policy if exists cakes_select_public on public.cakes;
drop policy if exists cakes_insert_admin on public.cakes;
drop policy if exists cakes_update_admin on public.cakes;
drop policy if exists cakes_delete_admin on public.cakes;

create policy cakes_select_public on public.cakes
  for select to anon, authenticated
  using (true);

create policy cakes_insert_admin on public.cakes
  for insert to authenticated
  with check (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

create policy cakes_update_admin on public.cakes
  for update to authenticated
  using (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

create policy cakes_delete_admin on public.cakes
  for delete to authenticated
  using (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

-- -----------------------------------------------------------------------------
-- customers
--   - INSERT: 直接の INSERT は禁止（handle_new_user トリガ経由のみ）
--   - SELECT: 本人のみ（auth.uid() = auth_user_id）または admin
--   - UPDATE/DELETE: 本人のみ
-- -----------------------------------------------------------------------------
drop policy if exists customers_insert_public on public.customers;
drop policy if exists customers_select_authenticated on public.customers;

-- INSERT 許可ポリシーを置かない = anon/authenticated からの直接 INSERT は不可。
-- handle_new_user トリガは security definer なのでこの制約を受けない。

create policy customers_select_self on public.customers
  for select to authenticated
  using (
    auth.uid() = auth_user_id
    or coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

create policy customers_update_self on public.customers
  for update to authenticated
  using (auth.uid() = auth_user_id);

create policy customers_delete_self on public.customers
  for delete to authenticated
  using (auth.uid() = auth_user_id);

-- -----------------------------------------------------------------------------
-- orders / order_items
--   - SELECT: 本人の注文のみ（customer.auth_user_id = auth.uid()）
--   - INSERT は明示的に許可しない（place_order 関数 = SECURITY DEFINER 経由のみ）
--   - place_order 関数は引き続き呼べる（function 自体への RLS は無く、
--     関数内で auth.uid() を見てチェックする運用に拡張可能）
-- -----------------------------------------------------------------------------
drop policy if exists orders_select_authenticated on public.orders;
drop policy if exists order_items_select_authenticated on public.order_items;

create policy orders_select_self on public.orders
  for select to authenticated
  using (
    exists (
      select 1
        from public.customers c
       where c.id = orders.customer_id
         and c.auth_user_id = auth.uid()
    )
    or coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );

create policy order_items_select_self on public.order_items
  for select to authenticated
  using (
    exists (
      select 1
        from public.orders o
        join public.customers c on c.id = o.customer_id
       where o.id = order_items.order_id
         and c.auth_user_id = auth.uid()
    )
    or coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
  );
