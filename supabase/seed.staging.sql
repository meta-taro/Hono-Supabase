-- =============================================================================
-- seed.staging.sql
--   staging 環境（Cloudflare Workers の [env.staging] が指す別 Supabase プロジェクト
--   = "Hono-Supabase-STG"）に投入する「伏せたテストデータ」。
--
--   ★これは合成データ（synthetic）であり、本番 DB のダンプではない★
--     - 実在の人物・実在のメールアドレスは一切含まない
--     - メールは RFC 2606 で予約された `.example` TLD を使う（誤送信が物理的に起きない）
--     - パスワードは「明らかに使い捨てとわかるダミー」を埋め込む（後述）
--     - 現状の本番データに PII は無いが、「本番ダンプを staging に流さない」習慣を
--       身につけるための演習として、最初から合成データだけで構成する
--
--   匿名化（anonymization）の考え方をこのファイルで実践している:
--     - 直接識別子（氏名・メール）        … ダミー値（テスト顧客NNN / customerNNN@staging.example）
--     - 準識別子（注文日時 placed_at）    … 日単位に丸めて一般化（時刻を 00:00:00 に固定）
--                                            ＝ 個人の購入時刻パターンから本人を絞り込めなくする
--     - created_at / updated_at           … 投入時刻（now()）。本番由来でないので業務的意味なし
--   ※ 本番由来データを伏せる本番運用では placed_at 以外のタイムスタンプも一般化する。
--     ここはゼロから作った合成データなので now() のままで問題ない。
--
--   なぜ customers に直接 INSERT しないのか（Phase 6 の設計）:
--     0004_phase6_auth.sql で customers.auth_user_id が auth.users への NOT NULL FK になり、
--     customers への直接 INSERT は RLS で禁止された。顧客行は auth.users への INSERT を
--     受けて handle_new_user トリガが 1:1 で自動生成する設計。よって seed も
--     「auth.users（+ auth.identities）を入れる → トリガが customers を作る」順で書く。
--     これは本番のサインアップ経路（supabase.auth.signUp）と同じ道筋。
--
--   投入方法（staging プロジェクトに対して手動で流す）:
--     1. supabase link --project-ref gnvlfivangrgyryjmybu
--     2. supabase db push                       # 4 マイグレーションを適用
--     3. psql "<staging の Postgres 接続文字列>" -f supabase/seed.staging.sql
--        （接続文字列は Supabase ダッシュボード → Project Settings → Database → Connection string）
--   ※ `supabase db reset` が自動投入するのは seed.sql の方。staging では reset は使わない
--     （リモート DB を破壊するため）。このファイルは明示的に psql で流すこと。
--
--   再実行安全性:
--     - cakes は ON CONFLICT DO NOTHING、auth users は「同 id が無ければ作る」、
--       orders/order_items/在庫減算は「orders が空のときだけ」実行（DO ブロックでガード）。
--     - ただし orders を消して再投入すると在庫がさらに減る点だけ注意（学習用なので許容）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 商品マスタ（cakes）
--   商品カタログは機密でないので、ローカルの seed.sql と同じ 5 品をそのまま使う。
-- -----------------------------------------------------------------------------
insert into public.cakes (id, name, price, stock) values
  ('11111111-1111-4111-8111-111111111111', 'ショートケーキ',     480, 20),
  ('22222222-2222-4222-8222-222222222222', 'モンブラン',         520, 15),
  ('33333333-3333-4333-8333-333333333333', 'チョコレートケーキ', 560, 18),
  ('44444444-4444-4444-8444-444444444444', 'チーズケーキ',       500, 12),
  ('55555555-5555-4555-8555-555555555555', 'ガトーショコラ',     580, 10)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 認証ユーザー（auth.users / auth.identities）— 合成データ
--   ここに INSERT すると on_auth_user_created トリガ → handle_new_user が走り、
--   public.customers 行が auth_user_id 付きで 1:1 自動生成される。
--
--   含めるユーザー:
--     テスト顧客001 / customer001@staging.example   （一般顧客）
--     テスト顧客002 / customer002@staging.example   （一般顧客）
--     テスト顧客003 / customer003@staging.example   （一般顧客）
--     テスト管理者 / admin@staging.example          （app_metadata.role = 'admin'）
--                                                   → 管理者専用エンドポイント
--                                                     （GET /v1/customers 等）の動作確認用
--
--   ★パスワードは全員 'staging-only-DO-NOT-REUSE' の bcrypt ハッシュ★
--     staging（使い捨て）専用の値。本番や他環境では絶対に使い回さないこと。
--     email_confirmed_at を now() にしてあるので、このユーザーはそのままログイン可能。
-- -----------------------------------------------------------------------------
do $$
declare
  v_users jsonb := $json$[
    {"id":"aaaa0001-0000-4000-8000-000000000001","email":"customer001@staging.example","name":"テスト顧客001","admin":false},
    {"id":"aaaa0002-0000-4000-8000-000000000002","email":"customer002@staging.example","name":"テスト顧客002","admin":false},
    {"id":"aaaa0003-0000-4000-8000-000000000003","email":"customer003@staging.example","name":"テスト顧客003","admin":false},
    {"id":"aaaa9999-0000-4000-8000-000000009999","email":"admin@staging.example","name":"テスト管理者","admin":true}
  ]$json$::jsonb;
  v_u      jsonb;
  v_id     uuid;
  v_email  text;
  v_name   text;
  v_admin  boolean;
  v_appmeta jsonb;
begin
  for v_u in select * from jsonb_array_elements(v_users) loop
    v_id    := (v_u->>'id')::uuid;
    v_email := v_u->>'email';
    v_name  := v_u->>'name';
    v_admin := (v_u->>'admin')::boolean;

    if exists (select 1 from auth.users where id = v_id) then
      raise notice 'auth user % already exists — skipping', v_email;
      continue;
    end if;

    v_appmeta := jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'));
    if v_admin then
      v_appmeta := v_appmeta || jsonb_build_object('role', 'admin');
    end if;

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      crypt('staging-only-DO-NOT-REUSE', gen_salt('bf')), now(),
      v_appmeta, jsonb_build_object('name', v_name),
      now(), now(),
      '', '', '', ''
    );

    -- email プロバイダの identity 行（GoTrue がログイン時に参照する）
    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_id::text, v_id,
      jsonb_build_object('sub', v_id::text, 'email', v_email),
      'email', now(), now(), now()
    );
  end loop;
end $$;
-- ↑ ここまでで public.customers に 4 行（顧客 3 + 管理者 1）が自動生成されている

-- -----------------------------------------------------------------------------
-- 注文（orders / order_items）+ 在庫減算 — 合成データ
--   place_order Function を通さず直接 INSERT するため、整合性のために cakes.stock も
--   ここで手動減算する（place_order がやっていることを seed でも再現する）。
--   customer_id は customers.id（トリガが自動採番）を auth_user_id 経由のサブクエリで引く。
--   placed_at は日単位に丸めた合成日時（時刻情報を伏せる＝準識別子の一般化）。
--
--   注文 1: テスト顧客001 / 2026-05-01 / ショートケーキ×2 + チョコレートケーキ×1 = 1,520 円
--   注文 2: テスト顧客002 / 2026-05-03 / ガトーショコラ×3                       = 1,740 円
--   注文 3: テスト顧客001 / 2026-05-05 / モンブラン×1 + チーズケーキ×2          = 1,520 円
--     （注文 1 と 3 が同じ顧客 = リピート購入のパターンも再現）
-- -----------------------------------------------------------------------------
do $$
declare
  v_c1 uuid := (select id from public.customers where auth_user_id = 'aaaa0001-0000-4000-8000-000000000001');
  v_c2 uuid := (select id from public.customers where auth_user_id = 'aaaa0002-0000-4000-8000-000000000002');
begin
  if exists (select 1 from public.orders) then
    raise notice 'orders already populated — skipping staging order seed';
    return;
  end if;
  if v_c1 is null or v_c2 is null then
    raise exception 'staging customers not found — run the auth.users seed block first';
  end if;

  -- 注文ヘッダ
  insert into public.orders (id, customer_id, status, total_amount, placed_at) values
    ('bbbb0001-0000-4000-8000-000000000001', v_c1, 'PLACED', 1520, '2026-05-01 00:00:00+00'),
    ('bbbb0002-0000-4000-8000-000000000002', v_c2, 'PLACED', 1740, '2026-05-03 00:00:00+00'),
    ('bbbb0003-0000-4000-8000-000000000003', v_c1, 'PLACED', 1520, '2026-05-05 00:00:00+00');

  -- 注文明細（unit_price は注文時点の単価スナップショット = 現在の cakes.price と一致させてある）
  insert into public.order_items (order_id, cake_id, quantity, unit_price, subtotal) values
    -- 注文 1
    ('bbbb0001-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 2, 480,  960),
    ('bbbb0001-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 1, 560,  560),
    -- 注文 2
    ('bbbb0002-0000-4000-8000-000000000002', '55555555-5555-4555-8555-555555555555', 3, 580, 1740),
    -- 注文 3
    ('bbbb0003-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 1, 520,  520),
    ('bbbb0003-0000-4000-8000-000000000003', '44444444-4444-4444-8444-444444444444', 2, 500, 1000);

  -- 在庫減算（place_order と同じ結果になるように）
  update public.cakes set stock = stock - 2 where id = '11111111-1111-4111-8111-111111111111'; -- ショートケーキ:    20 → 18
  update public.cakes set stock = stock - 1 where id = '22222222-2222-4222-8222-222222222222'; -- モンブラン:        15 → 14
  update public.cakes set stock = stock - 1 where id = '33333333-3333-4333-8333-333333333333'; -- チョコレートケーキ: 18 → 17
  update public.cakes set stock = stock - 2 where id = '44444444-4444-4444-8444-444444444444'; -- チーズケーキ:      12 → 10
  update public.cakes set stock = stock - 3 where id = '55555555-5555-4555-8555-555555555555'; -- ガトーショコラ:    10 → 7
end $$;
