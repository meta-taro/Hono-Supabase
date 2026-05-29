import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { Cake } from '@/modules/cakes/domain/cake';
import type { CakeId } from '@/modules/cakes/domain/cake-id.vo';
import type {
  CakePage,
  CakeRepository,
  CakeSortField,
  ListCakesParams,
} from '@/modules/cakes/domain/cake.repository';
import { ConflictError } from '@/shared/domain/errors';

// DB 行の型。domain の Cake と独立させる（DB の都合 — snake_case や
// timestamptz の文字列表現 — が domain 層に漏れないようにするため）。
// select で取得するのは domain が必要とする 5 列（version 含む）のみ。
interface CakeRow {
  id: string;
  name: string;
  price: number;
  stock: number;
  version: number;
}

const TABLE_NAME = 'cakes';

// select する列。version は楽観ロックの版（ETag の素）。domain の Cake が必須とする。
const CAKE_COLUMNS = 'id, name, price, stock, version';

// Postgres エラーコード（PostgREST はこのコードを error.code に転載する）。
// 23505 = unique_violation。詳細: https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = '23505';

// PostgREST のフィルタ値はカンマ・括弧・ピリオド等の予約文字を含むと
// `or(...)` の構文自体を壊す。ダブルクォートで囲み、内部の \ と " をエスケープする。
// （値は PostgREST 側で SQL にバインドされるため SQL インジェクションは起きないが、
//   引用しないとフィルタ式が壊れて誤った結果や 400 になる。）
const pgrstQuoteValue = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// キーセットの比較値を PostgREST のフィルタ表現に整形する。
// 数値はそのまま、文字列は予約文字対策で必ずクォートする。
const formatKeysetValue = (value: string | number): string =>
  typeof value === 'number' ? String(value) : pgrstQuoteValue(value);

interface KeysetColumn {
  column: string;
  ascending: boolean;
  value: string | number;
}

// 多カラムキーセットの「after より厳密に後ろ」を表す or(...) 式を組み立てる。
//   (c1 OP1 v1)
//   OR (c1 = v1 AND c2 OP2 v2)
//   OR (c1 = v1 AND c2 = v2 AND ... AND ck OPk vk)
// OPk は昇順なら gt、降順なら lt。前段カラムは eq で固定する。
// これにより ORDER BY と同じ並びの「続き」だけを過不足なく拾える。
const buildKeysetOr = (columns: KeysetColumn[]): string => {
  const terms = columns.map((pivot, k) => {
    const op = pivot.ascending ? 'gt' : 'lt';
    const pivotCond = `${pivot.column}.${op}.${formatKeysetValue(pivot.value)}`;
    // 先頭カラムは単独の比較。以降は前段カラムを eq で固定した and(...) で包む。
    if (k === 0) return pivotCond;
    const eqConds = columns
      .slice(0, k)
      .map((prev) => `${prev.column}.eq.${formatKeysetValue(prev.value)}`);
    return `and(${[...eqConds, pivotCond].join(',')})`;
  });
  return terms.join(',');
};

// CakeRow から指定ソートフィールドの値を取り出す（nextCursor 構築用）。
const rowValueOf = (row: CakeRow, field: CakeSortField): string | number => row[field];

export class CakeSupabaseRepository implements CakeRepository {
  // SupabaseClient は composition-root で anon / admin を選んで注入する。
  // ここでは「どのキーで動いているか」を意識せず、与えられた client を使うだけ。
  constructor(private readonly sb: SupabaseClient) {}

  async list(params: ListCakesParams): Promise<CakePage> {
    // nameSearch があれば PGroonga 全文検索（search_cakes RPC）に委譲する。
    // PostgREST のクエリビルダは PGroonga 演算子 `&@` を表現できないため、
    // ソート・フィルタ・キーセットごと RPC 側（動的 SQL）に寄せている。
    // nameSearch が無ければ従来の PostgREST 経路で組み立てる。
    const rows =
      params.filter.nameSearch !== undefined
        ? await this.fetchViaSearch(params)
        : await this.fetchViaQuery(params);

    // limit + 1 件取得しているので、超過分があれば「次ページあり」と判定する。
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;

    // 行 → Entity 変換は必ず Cake.reconstruct() 経由で行う。
    // これにより UUID 形式チェック等の domain 不変条件が DB 由来データにも適用される。
    const cakes = page.map((row) => Cake.reconstruct(row));

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? {
            sort: params.sort,
            values: Object.fromEntries(
              params.sort.map((key) => [key.field, rowValueOf(lastRow, key.field)]),
            ) as Partial<Record<CakeSortField, string | number>>,
            id: lastRow.id,
          }
        : null;

    return { cakes, nextCursor };
  }

  // PostgREST 経路（検索語なし）。フィルタ + キーセット + 並び順をクエリビルダで組む。
  private async fetchViaQuery(params: ListCakesParams): Promise<CakeRow[]> {
    let query = this.sb.from(TABLE_NAME).select(CAKE_COLUMNS);

    // --- フィルタ（各条件は AND で結合される）---
    const { available, minPrice, maxPrice } = params.filter;
    if (available === true) query = query.gt('stock', 0);
    if (available === false) query = query.eq('stock', 0);
    if (minPrice !== undefined) query = query.gte('price', minPrice);
    if (maxPrice !== undefined) query = query.lte('price', maxPrice);

    // --- キーセット: ORDER BY と同じ並びの「続き」だけに絞る ---
    if (params.after) {
      const after = params.after;
      const columns: KeysetColumn[] = [];
      for (const key of params.sort) {
        const value = after.values[key.field];
        // カーソルは sort 各フィールドの値を保持しているはず。
        // 欠落していたら不正なカーソルなので、黙って誤ったページを返さず明示的に落とす。
        if (value === undefined) {
          throw new Error(`カーソルにソートフィールド '${key.field}' の値がありません`);
        }
        columns.push({ column: key.field, ascending: key.direction === 'asc', value });
      }
      columns.push({ column: 'id', ascending: true, value: after.id });
      query = query.or(buildKeysetOr(columns));
    }

    // --- 並び順: sort 各フィールド + id 昇順 tiebreaker（キーセット条件と同じ並び）---
    for (const key of params.sort) {
      query = query.order(key.field, { ascending: key.direction === 'asc' });
    }
    query = query.order('id', { ascending: true });

    const { data, error } = await query
      .limit(params.limit + 1)
      .overrideTypes<CakeRow[], { merge: false }>();

    if (error) {
      throw new Error(`Cake 一覧の取得に失敗しました: ${error.message}`);
    }
    return data;
  }

  // PGroonga 経路（検索語あり）。search_cakes RPC に委譲する。
  // フィルタ・ソート・キーセットは関数側の動的 SQL が処理するため、
  // ここはパラメータの受け渡しに徹する（未指定は null で渡し、関数の既定に任せる）。
  private async fetchViaSearch(params: ListCakesParams): Promise<CakeRow[]> {
    const { filter, sort, after, limit } = params;
    const { data, error } = (await this.sb.rpc('search_cakes', {
      p_q: filter.nameSearch,
      p_available: filter.available ?? null,
      p_min_price: filter.minPrice ?? null,
      p_max_price: filter.maxPrice ?? null,
      p_sort: sort.map((key) => ({ field: key.field, direction: key.direction })),
      p_after: after ? { values: after.values, id: after.id } : null,
      p_limit: limit + 1,
    })) as { data: CakeRow[] | null; error: PostgrestError | null };

    if (error) {
      throw new Error(`Cake 検索に失敗しました: ${error.message}`);
    }
    // RPC は cakes 全カラムを返すが、CakeRow が必要とする 4 列だけ読む（余剰は無視）。
    return data ?? [];
  }

  async save(cake: Cake): Promise<void> {
    const { error } = await this.sb.from(TABLE_NAME).insert({
      id: cake.id.value,
      name: cake.name,
      price: cake.price.value,
      stock: cake.stock,
    });

    if (!error) return;

    // Postgres の制約違反をドメイン例外にマッピングして上位層に伝える。
    // application / presentation 層は Postgres を知らなくても適切な HTTP レスポンスを返せる。
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError(`Cake (id=${cake.id.value}) は既に登録されています`);
    }

    throw new Error(`Cake の保存に失敗しました: ${error.message}`);
  }

  async findById(id: CakeId): Promise<Cake | null> {
    // maybeSingle: 0 件なら data=null（エラーにしない）、1 件なら行、2 件以上ならエラー。
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(CAKE_COLUMNS)
      .eq('id', id.value)
      .maybeSingle<CakeRow>();

    if (error) {
      throw new Error(`Cake の取得に失敗しました: ${error.message}`);
    }
    return data ? Cake.reconstruct(data) : null;
  }

  async updateStock(id: CakeId, newStock: number, expectedVersion: number): Promise<Cake | null> {
    // 楽観ロックの核心: WHERE id = ? AND version = ? の複合条件で更新する。
    //   - 版が一致した行だけが更新対象になる（誰かが先に更新して版が進んでいたら 0 件）。
    //   - version の採番（+1）は DB トリガ（cakes_bump_version）が担うため、ここでは触らない。
    //   - .select() で更新後の行（採番済みの新 version 含む）を返してもらう。
    //   - 0 件更新は maybeSingle で data=null となり、UseCase 側が 412 に倒す（競合 or 行消失）。
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .update({ stock: newStock })
      .eq('id', id.value)
      .eq('version', expectedVersion)
      .select(CAKE_COLUMNS)
      .maybeSingle<CakeRow>();

    if (error) {
      throw new Error(`Cake 在庫の更新に失敗しました: ${error.message}`);
    }
    return data ? Cake.reconstruct(data) : null;
  }
}
