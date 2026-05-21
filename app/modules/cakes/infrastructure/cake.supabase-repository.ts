import type { SupabaseClient } from '@supabase/supabase-js';
import { Cake } from '@/modules/cakes/domain/cake';
import type {
  CakePage,
  CakeRepository,
  CakeSortField,
  ListCakesParams,
} from '@/modules/cakes/domain/cake.repository';
import { ConflictError } from '@/shared/domain/errors';

// DB 行の型。domain の Cake と独立させる（DB の都合 — snake_case や
// timestamptz の文字列表現 — が domain 層に漏れないようにするため）。
// select で取得するのは domain が必要とする 4 列のみ。
interface CakeRow {
  id: string;
  name: string;
  price: number;
  stock: number;
}

const TABLE_NAME = 'cakes';

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
    let query = this.sb.from(TABLE_NAME).select('id, name, price, stock');

    // --- フィルタ（各条件は AND で結合される）---
    const { available, minPrice, maxPrice, nameContains } = params.filter;
    if (available === true) query = query.gt('stock', 0);
    if (available === false) query = query.eq('stock', 0);
    if (minPrice !== undefined) query = query.gte('price', minPrice);
    if (maxPrice !== undefined) query = query.lte('price', maxPrice);
    if (nameContains !== undefined) {
      // ILIKE の部分一致。'%' / '_' を含む入力はワイルドカードとして作用する点に注意
      // （= 利用者が任意の前方/後方一致を指定できる簡易仕様。値は supabase-js が
      //   URL エンコードするためフィルタ構文自体は壊れない）。
      query = query.ilike('name', `%${nameContains}%`);
    }

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

    // limit + 1 件取得し、超過分があれば「次ページあり」と判定する。
    const { data, error } = await query
      .limit(params.limit + 1)
      .overrideTypes<CakeRow[], { merge: false }>();

    if (error) {
      throw new Error(`Cake 一覧の取得に失敗しました: ${error.message}`);
    }

    const hasMore = data.length > params.limit;
    const rows = hasMore ? data.slice(0, params.limit) : data;

    // 行 → Entity 変換は必ず Cake.reconstruct() 経由で行う。
    // これにより UUID 形式チェック等の domain 不変条件が DB 由来データにも適用される。
    const cakes = rows.map((row) => Cake.reconstruct(row));

    const lastRow = rows[rows.length - 1];
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
}
