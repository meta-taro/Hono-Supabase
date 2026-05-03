import type { SupabaseClient } from '@supabase/supabase-js';
import { Cake } from '@/modules/cakes/domain/cake';
import type { CakeRepository } from '@/modules/cakes/domain/cake.repository';
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

export class CakeSupabaseRepository implements CakeRepository {
  // SupabaseClient は composition-root で anon / admin を選んで注入する。
  // ここでは「どのキーで動いているか」を意識せず、与えられた client を使うだけ。
  constructor(private readonly sb: SupabaseClient) {}

  async list(): Promise<Cake[]> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select('id, name, price, stock')
      .order('name', { ascending: true })
      .returns<CakeRow[]>();

    if (error) {
      throw new Error(`Cake 一覧の取得に失敗しました: ${error.message}`);
    }

    // 行 → Entity 変換は必ず Cake.reconstruct() 経由で行う。
    // これにより UUID 形式チェック等の domain 不変条件が DB 由来データにも適用される。
    return (data ?? []).map((row) => Cake.reconstruct(row));
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
