-- =============================================================================
-- Phase 10 Step 4: ケーキ在庫更新の楽観ロック（version カラム + 自動採番トリガ）
-- =============================================================================
-- なぜ version カラムか:
--   PATCH /v1/cakes/{id}（在庫更新）で「他の管理者が先に更新していたら気付かず
--   上書きする（lost update）」事故を防ぐ。クライアントは GET で得た版を ETag →
--   If-Match で提示し、サーバは `WHERE id = ? AND version = ?` で更新する。
--   版が進んでいれば 0 件更新となり、アプリ層が 412 PRECONDITION_FAILED に倒す。
--
-- なぜ DB トリガで採番するか:
--   版の +1 をアプリ任せにすると、SQL を直接叩く経路や別サービスからの更新で
--   版が進まず楽観ロックが破れる。BEFORE UPDATE トリガで「どの経路の UPDATE でも
--   必ず version が 1 進む」ことを DB 側で保証する（不変条件を一元化）。
--
-- ETag との対応:
--   GET /v1/cakes/{id} は version を Weak ETag（W/"<version>"）として返す。
--   PATCH 成功時は採番後の version を新しい ETag として返す。
-- -----------------------------------------------------------------------------

-- version カラム（既存行は default 1 で埋まる。NOT NULL 制約も満たせる）。
alter table public.cakes
  add column if not exists version integer not null default 1;

comment on column public.cakes.version is
  '楽観ロックの版。UPDATE のたびにトリガで +1 される（ETag の素）。';

-- -----------------------------------------------------------------------------
-- version 自動採番トリガ関数
--   BEFORE UPDATE で OLD.version + 1 を NEW.version に設定する。
--   クライアントが version を直接書き換えても無視され、必ず単調増加する。
-- -----------------------------------------------------------------------------
create or replace function public.bump_version()
returns trigger
language plpgsql
as $$
begin
  new.version = old.version + 1;
  return new;
end;
$$;

comment on function public.bump_version() is
  '汎用 version 自動採番トリガ関数。楽観ロック対象テーブルの before update で利用する。';

-- cakes に version 採番トリガを付与。
--   トリガ名はアルファベット順で cakes_set_updated_at より後ろになるが、
--   両者とも別カラム（updated_at / version）を触るだけなので発火順は結果に影響しない。
drop trigger if exists cakes_bump_version on public.cakes;
create trigger cakes_bump_version
  before update on public.cakes
  for each row
  execute function public.bump_version();
