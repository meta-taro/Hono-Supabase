-- =============================================================================
-- 0003_create_orders_tables.sql
--   orders / order_items テーブルと place_order Postgres Function を作成する。
--   place_order は「在庫減算 + 注文挿入 + 明細挿入」を 1 トランザクションでアトミック実行する。
--   set_updated_at() は 0001 で作成済みのため再利用する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- orders テーブル（注文ヘッダ）
--   domain/order.ts と domain/order-status.ts の不変条件を CHECK 制約として
--   DB にも持たせ、アプリ層をバイパスした直接 INSERT でも壊れたデータが
--   入らないよう二重防御する。
-- -----------------------------------------------------------------------------
create table public.orders (
  id            uuid          primary key default gen_random_uuid(),
  customer_id   uuid          not null references public.customers(id),
  status        varchar(16)   not null,
  total_amount  integer       not null,
  placed_at     timestamptz   not null default now(),
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),

  constraint orders_status_check
    check (status in ('PLACED', 'CANCELED')),

  -- total_amount > 0 は「明細 1 件以上 + 単価 1 円以上」の帰結。
  -- place_order 内で必ずこの条件を満たすが、DB でも明示的に守る。
  constraint orders_total_amount_positive_check
    check (total_amount > 0)
);

create index orders_customer_id_idx  on public.orders (customer_id);
create index orders_placed_at_idx    on public.orders (placed_at desc);

create trigger orders_set_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();

comment on table  public.orders               is '注文ヘッダ';
comment on column public.orders.id            is '注文 ID（UUID v4 / DEFAULT で自動採番）';
comment on column public.orders.customer_id   is '注文者の顧客 ID';
comment on column public.orders.status        is '注文ステータス（PLACED / CANCELED）';
comment on column public.orders.total_amount  is '注文合計金額（円・正の整数）';
comment on column public.orders.placed_at     is '注文確定日時（UTC）';

-- -----------------------------------------------------------------------------
-- order_items テーブル（注文明細）
--   1 注文 1 商品で 1 行（同じ cake_id を 2 行に分けない仕様 = UNIQUE 制約）。
--   unit_price は注文時点のスナップショット（cakes.price が変わっても固定）。
-- -----------------------------------------------------------------------------
create table public.order_items (
  id          uuid          primary key default gen_random_uuid(),
  order_id    uuid          not null references public.orders(id) on delete cascade,
  cake_id     uuid          not null references public.cakes(id),
  quantity    integer       not null,
  unit_price  integer       not null,
  subtotal    integer       not null,
  created_at  timestamptz   not null default now(),

  constraint order_items_quantity_range_check
    check (quantity between 1 and 100),

  constraint order_items_unit_price_range_check
    check (unit_price between 1 and 1000000),

  constraint order_items_subtotal_positive_check
    check (subtotal > 0),

  -- 同一注文内で同じ商品を 2 行に分けない = domain.assertItemsShape() を DB でも担保
  constraint order_items_order_cake_unique
    unique (order_id, cake_id)
);

create index order_items_order_id_idx  on public.order_items (order_id);

comment on table  public.order_items              is '注文明細';
comment on column public.order_items.unit_price   is '注文時点の単価スナップショット（cakes.price の変動と独立）';

-- -----------------------------------------------------------------------------
-- place_order: 注文確定の Postgres Function
--   なぜ Function に落とすのか:
--     - 「在庫の確認 → 減算 → 注文挿入 → 明細挿入」をアトミックに実行する必要がある
--     - アプリ層から複数 SQL を投げるとレースコンディション窓ができる
--     - Function 内なら 1 トランザクション + FOR UPDATE で並行注文を直列化できる
--
--   入力:
--     p_customer_id : 注文者の顧客 ID（customers.id）
--     p_items       : jsonb 配列 [{"cake_id": uuid, "quantity": int}, ...]
--   出力:
--     uuid          : 作成された注文 ID
--   失敗時:
--     - 顧客なし          → exception (errcode P0002)
--     - 商品なし          → exception (errcode P0002)
--     - 在庫不足          → exception (errcode P0003 / メッセージに available/requested を含める)
--     - 制約違反 / その他  → 既定のエラー伝播
--
--   SECURITY DEFINER:
--     関数所有者権限で実行する。RLS は呼び出しユーザーに対しては適用されるが、
--     関数内の SQL は所有者（postgres）として動くため、Phase 6 で RLS を厳密化しても
--     注文確定経路は引き続き機能する。
-- -----------------------------------------------------------------------------
create or replace function public.place_order(
  p_customer_id uuid,
  p_items       jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_order_id        uuid := gen_random_uuid();
  v_total           integer := 0;
  v_item            jsonb;
  v_cake_id         uuid;
  v_quantity        integer;
  v_cake_price      integer;
  v_cake_stock      integer;
  v_subtotal        integer;
  v_processed_items jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = '22000';
  end if;

  -- 顧客存在チェック
  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'CUSTOMER_NOT_FOUND %', p_customer_id
      using errcode = 'P0002';
  end if;

  -- pass 1: 全件検証（FOR UPDATE で在庫行をロック取得 → 並行注文を直列化）
  -- 在庫減算 + 明細データ収集も同時に行う。1 つでも失敗したら raise で全体ロールバック。
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cake_id  := (v_item->>'cake_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;

    select price, stock
      into v_cake_price, v_cake_stock
      from public.cakes
      where id = v_cake_id
      for update;

    if not found then
      raise exception 'CAKE_NOT_FOUND %', v_cake_id
        using errcode = 'P0002';
    end if;

    if v_cake_stock < v_quantity then
      raise exception 'INSUFFICIENT_STOCK cake_id=% available=% requested=%',
        v_cake_id, v_cake_stock, v_quantity
        using errcode = 'P0003';
    end if;

    v_subtotal := v_cake_price * v_quantity;
    v_total    := v_total + v_subtotal;

    -- 在庫減算（FOR UPDATE 取得済みなので安全）
    update public.cakes
       set stock = stock - v_quantity
     where id = v_cake_id;

    v_processed_items := v_processed_items || jsonb_build_object(
      'cake_id',    v_cake_id,
      'quantity',   v_quantity,
      'unit_price', v_cake_price,
      'subtotal',   v_subtotal
    );
  end loop;

  -- 注文ヘッダを挿入（合計金額確定済み）
  insert into public.orders (id, customer_id, status, total_amount, placed_at)
  values (v_order_id, p_customer_id, 'PLACED', v_total, now());

  -- 明細を挿入
  for v_item in select * from jsonb_array_elements(v_processed_items) loop
    insert into public.order_items (order_id, cake_id, quantity, unit_price, subtotal)
    values (
      v_order_id,
      (v_item->>'cake_id')::uuid,
      (v_item->>'quantity')::integer,
      (v_item->>'unit_price')::integer,
      (v_item->>'subtotal')::integer
    );
  end loop;

  return v_order_id;
end;
$$;

comment on function public.place_order(uuid, jsonb) is
  '注文確定: 在庫減算 + orders/order_items への INSERT を 1 トランザクションでアトミック実行する。';

-- -----------------------------------------------------------------------------
-- Row Level Security
--   Phase 5 段階のポリシー設計：
--     - SELECT は authenticated のみ（一覧取得は今のところ未実装、詳細取得のみ）
--     - INSERT は明示的に拒否（place_order Function 経由のみ許可）
--   Phase 6 で「authenticated ユーザは自分の customer_id の注文のみ select 可」へ絞る。
--   service_role キーは RLS をバイパスするため、infrastructure テストはこのまま通る。
-- -----------------------------------------------------------------------------
alter table public.orders       enable row level security;
alter table public.order_items  enable row level security;

create policy orders_select_authenticated on public.orders
  for select to authenticated
  using (true);

create policy order_items_select_authenticated on public.order_items
  for select to authenticated
  using (true);
