import type { SupabaseClient } from '@supabase/supabase-js';
import { Cake } from '@/modules/cakes/domain/cake';
import type {
  CakePage,
  CakeRepository,
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
//   引用しないとフィルタ式が壊れて誤った結果や 400 になる。ケーキ名は任意文字列なので必須。）
const pgrstQuoteValue = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class CakeSupabaseRepository implements CakeRepository {
  // SupabaseClient は composition-root で anon / admin を選んで注入する。
  // ここでは「どのキーで動いているか」を意識せず、与えられた client を使うだけ。
  constructor(private readonly sb: SupabaseClient) {}

  async list(params: ListCakesParams): Promise<CakePage> {
    const base = this.sb.from(TABLE_NAME).select('id, name, price, stock');

    // キーセット法: (name, id) > (after.name, after.id) を満たす行に絞る。
    //   name.gt.X            … 名前が後ろの行
    //   and(name.eq.X, id.gt.Y) … 同名なら id で先に進む（同名の取りこぼし防止）
    const filtered = params.after
      ? base.or(
          `name.gt.${pgrstQuoteValue(params.after.name)},` +
            `and(name.eq.${pgrstQuoteValue(params.after.name)},id.gt.${pgrstQuoteValue(params.after.id)})`,
        )
      : base;

    // limit + 1 件取得し、超過分があれば「次ページあり」と判定する。
    // ORDER BY は name, id の複合（キーセット条件と同じ並びでなければ整合しない）。
    const { data, error } = await filtered
      .order('name', { ascending: true })
      .order('id', { ascending: true })
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

    const last = cakes[cakes.length - 1];
    const nextCursor = hasMore && last ? { name: last.name, id: last.id.value } : null;

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
