-- =============================================================================
-- Phase 10 Step 3: ケーキ名のあいまい検索（PGroonga 全文検索）
-- =============================================================================
-- なぜ PGroonga か:
--   日本語のケーキ名は単語境界が無いため、PostgreSQL 標準の tsvector（FTS）の
--   デフォルトパーサではトークン分割できず使い物にならない。pg_trgm（文字トライグラム）
--   は ILIKE を高速化できるが、(1) 1〜2 文字クエリはトライグラム索引に乗らない、
--   (2) 苺／いちご／イチゴ が別トライグラム扱い、(3) スコアが粗い、という弱点がある。
--   PGroonga は Groonga ベースで N-gram（TokenBigram）索引を張るため、2 文字クエリも
--   ひらがな部分一致も拾える。索引は DB 側に閉じるため Cloudflare Workers バンドルには
--   一切影響しない（検索ロジックは下記 RPC = HTTP 経由で呼ぶだけ）。使い分けの詳細は
--   README「pg_trgm / tsvector / PGroonga の使い分け」を参照。
--
-- なぜ RPC（Postgres Function）か:
--   PostgREST のクエリビルダ（supabase-js）は eq/gt/ilike/fts 等は表現できるが、
--   PGroonga 演算子 `&@`（全文一致）を直接は呼べない。`place_order` と同じく
--   関数に閉じ込めて `.rpc('search_cakes', {...})` で呼ぶ。動的 SQL を組むため、
--   並び替えフィールドはホワイトリスト検証してから %I で、値は %L で埋め込む
--   （識別子と値を分離し、SQL インジェクションを構造的に防ぐ）。
-- -----------------------------------------------------------------------------

create extension if not exists pgroonga;

-- ケーキ名への PGroonga 索引。`name &@ 'クエリ'` がこの索引でドライブされる。
-- 既定ノーマライザ（NormalizerNFKC）で全角/半角・大文字小文字は吸収される。
-- （苺↔いちご↔イチゴ の異表記吸収まではノーマライザでは賄えない点は README に明記。
--   将来シノニム辞書を足すなら Groonga 側の機能で対応する。）
create index if not exists cakes_name_pgroonga_idx
  on public.cakes
  using pgroonga (name);

-- -----------------------------------------------------------------------------
-- search_cakes: あいまい検索 + フィルタ + 多段ソート + キーセットページネーション
--   p_q         … 検索語（PGroonga `&@` で全文一致）。必須。
--   p_available … true=在庫あり / false=在庫切れ / null=絞らない。
--   p_min_price … 価格下限（含む）。null=絞らない。
--   p_max_price … 価格上限（含む）。null=絞らない。
--   p_sort      … [{"field":"name|price|stock","direction":"asc|desc"}, ...]。
--                 既定は name 昇順。id 昇順を最終 tiebreaker として常に付与する。
--   p_after     … キーセットカーソル {"values":{"name":..,"price":..},"id":"uuid"}。
--                 null=先頭ページ。
--   p_limit     … 取得件数。呼び出し側は「次ページ有無」判定のため limit+1 を渡す。
--
--   返り値は setof public.cakes（全カラム）。呼び出し側は必要な 4 列だけ読む。
--   security invoker（既定）: cakes は RLS で全員 SELECT 可（cakes_select_public）
--   のため、呼び出しロール権限のままで成立する。place_order と違い権限昇格は不要。
-- -----------------------------------------------------------------------------
create or replace function public.search_cakes(
  p_q         text,
  p_available boolean default null,
  p_min_price integer default null,
  p_max_price integer default null,
  p_sort      jsonb   default '[{"field":"name","direction":"asc"}]'::jsonb,
  p_after     jsonb   default null,
  p_limit     integer default 20
)
returns setof public.cakes
language plpgsql
stable
security invoker
as $$
declare
  v_item   jsonb;
  v_field  text;
  v_dir    text;
  v_fields text[] := '{}';
  v_dirs   text[] := '{}';
  v_where  text;
  v_order  text := '';
  v_keyset text := '';
  v_term   text;
  v_cond   text;
  v_op     text;
  v_val    text;
  v_sql    text;
  i        integer;
  k        integer;
  j        integer;
begin
  -- sort をパースしてホワイトリスト検証。
  -- field は %I でも識別子として差し込むが、未許可カラム（例: created_at）を
  -- 並びキーに使わせないため、ここで明示的に弾く（許可: name / price / stock）。
  for v_item in select * from jsonb_array_elements(coalesce(p_sort, '[]'::jsonb)) loop
    v_field := v_item->>'field';
    v_dir   := v_item->>'direction';
    if v_field is null or v_field not in ('name', 'price', 'stock') then
      raise exception 'INVALID_SORT_FIELD %', v_field using errcode = '22000';
    end if;
    if v_dir is null or v_dir not in ('asc', 'desc') then
      raise exception 'INVALID_SORT_DIRECTION %', v_dir using errcode = '22000';
    end if;
    v_fields := array_append(v_fields, v_field);
    v_dirs   := array_append(v_dirs, v_dir);
  end loop;
  -- id 昇順を最終 tiebreaker として常に付ける（同値行でも順序を一意化）。
  v_fields := array_append(v_fields, 'id');
  v_dirs   := array_append(v_dirs, 'asc');

  -- ORDER BY 句を組み立て（field は %I、方向は検証済みの asc/desc のみ素で連結）。
  for i in 1 .. array_length(v_fields, 1) loop
    v_order := v_order || format('%I %s', v_fields[i], v_dirs[i]);
    if i < array_length(v_fields, 1) then
      v_order := v_order || ', ';
    end if;
  end loop;

  -- WHERE: PGroonga 全文一致 + 任意フィルタ（すべて AND 結合）。
  v_where := format('name &@ %L', p_q);
  if p_available is true  then v_where := v_where || ' and stock > 0'; end if;
  if p_available is false then v_where := v_where || ' and stock = 0'; end if;
  if p_min_price is not null then
    v_where := v_where || format(' and price >= %L', p_min_price);
  end if;
  if p_max_price is not null then
    v_where := v_where || format(' and price <= %L', p_max_price);
  end if;

  -- キーセット: ORDER BY と同じ並びの「続き」だけを過不足なく拾う OR 式。
  --   (f1 op v1)
  --   OR (f1 = v1 AND f2 op v2)
  --   OR (f1 = v1 AND ... AND id > id_v)
  -- op は昇順なら >、降順なら <。前段カラムは = で固定する。
  if p_after is not null then
    for k in 1 .. array_length(v_fields, 1) loop
      v_term := '';
      for j in 1 .. k loop
        v_field := v_fields[j];
        if v_field = 'id' then
          v_val := p_after->>'id';
        else
          v_val := p_after->'values'->>v_field;
        end if;
        if v_val is null then
          raise exception 'INVALID_CURSOR missing %', v_field using errcode = '22000';
        end if;
        if j < k then
          v_cond := format('%I = %L', v_field, v_val);
        else
          v_op   := case when v_dirs[j] = 'asc' then '>' else '<' end;
          v_cond := format('%I %s %L', v_field, v_op, v_val);
        end if;
        if v_term <> '' then v_term := v_term || ' and '; end if;
        v_term := v_term || v_cond;
      end loop;
      if v_keyset <> '' then v_keyset := v_keyset || ' or '; end if;
      v_keyset := v_keyset || '(' || v_term || ')';
    end loop;
    v_where := v_where || ' and (' || v_keyset || ')';
  end if;

  v_sql := format(
    'select * from public.cakes where %s order by %s limit %s',
    v_where, v_order, p_limit::text
  );
  return query execute v_sql;
end;
$$;
