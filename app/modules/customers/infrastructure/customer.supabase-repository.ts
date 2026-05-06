import type { SupabaseClient } from '@supabase/supabase-js';
import { Customer } from '@/modules/customers/domain/customer';
import type { CustomerRepository } from '@/modules/customers/domain/customer.repository';
import type { Email } from '@/modules/customers/domain/email.vo';
import { EmailAlreadyTakenError } from '@/modules/customers/domain/customer.errors';
import { ConflictError } from '@/shared/domain/errors';

// DB 行の型。domain の Customer と独立させる（DB の都合 — snake_case や
// timestamptz の文字列表現 — が domain 層に漏れないようにするため）。
// select で取得するのは domain が必要とする 3 列のみ。
interface CustomerRow {
  id: string;
  name: string;
  email: string;
}

const TABLE_NAME = 'customers';

// Postgres エラーコード（PostgREST はこのコードを error.code に転載する）。
// 23505 = unique_violation。詳細: https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = '23505';

// PostgREST が「結果 0 件 + .single()」のときに返すコード。
// findByEmail の「該当なし」を例外ではなく null 返却で扱うために使う。
const PGRST_NO_ROWS = 'PGRST116';

export class CustomerSupabaseRepository implements CustomerRepository {
  // SupabaseClient は composition-root で anon / admin を選んで注入する。
  // ここでは「どのキーで動いているか」を意識せず、与えられた client を使うだけ。
  constructor(private readonly sb: SupabaseClient) {}

  async list(): Promise<Customer[]> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select('id, name, email')
      .order('name', { ascending: true })
      .returns<CustomerRow[]>();

    if (error) {
      throw new Error(`Customer 一覧の取得に失敗しました: ${error.message}`);
    }

    // 行 → Entity 変換は必ず Customer.reconstruct() 経由で行う。
    // これにより UUID / Email 形式チェック等の domain 不変条件が DB 由来データにも適用される。
    return (data ?? []).map((row) => Customer.reconstruct(row));
  }

  async findByEmail(email: Email): Promise<Customer | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select('id, name, email')
      .eq('email', email.value)
      .maybeSingle<CustomerRow>();

    // maybeSingle() は 0 件を error ではなく data=null で返すが、
    // 念のため PGRST_NO_ROWS も null 扱いにフォールバックする。
    if (error && error.code !== PGRST_NO_ROWS) {
      throw new Error(`Customer の検索に失敗しました: ${error.message}`);
    }
    if (data === null) {
      return null;
    }

    return Customer.reconstruct(data);
  }

  async save(customer: Customer): Promise<void> {
    const { error } = await this.sb.from(TABLE_NAME).insert({
      id: customer.id.value,
      name: customer.name,
      email: customer.email.value,
    });

    if (!error) return;

    // Postgres の制約違反をドメイン例外にマッピングして上位層に伝える。
    // application / presentation 層は Postgres を知らなくても適切な HTTP レスポンスを返せる。
    if (error.code === PG_UNIQUE_VIOLATION) {
      // UNIQUE 違反は「メール」と「id」の 2 種類があり得る。
      // メッセージにテーブル名 / 制約名が乗ってくるので、メール側のみ専用例外に変換し
      // 業務的に意味のあるエラー（CONFLICT + メール重複の旨）として返す。
      const isEmailConflict = error.message.includes('email');
      if (isEmailConflict) {
        throw new EmailAlreadyTakenError(customer.email.value);
      }
      throw new ConflictError(`Customer (id=${customer.id.value}) は既に登録されています`);
    }

    throw new Error(`Customer の保存に失敗しました: ${error.message}`);
  }
}
