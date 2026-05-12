import type { SupabaseClient } from '@supabase/supabase-js';
import { Customer } from '@/modules/customers/domain/customer';
import type { CustomerRepository } from '@/modules/customers/domain/customer.repository';
import type { Email } from '@/modules/customers/domain/email.vo';

// DB 行の型。domain の Customer と独立させる（DB の都合 — snake_case や
// timestamptz の文字列表現 — が domain 層に漏れないようにするため）。
// Phase 6 で auth_user_id を必ず返すようにし、Customer.reconstruct に渡せる形にする。
interface CustomerRow {
  id: string;
  auth_user_id: string;
  name: string;
  email: string;
}

const TABLE_NAME = 'customers';
const SELECT_COLUMNS = 'id, auth_user_id, name, email';

// PostgREST が「結果 0 件 + .single()」のときに返すコード。
// findByEmail / findByAuthUserId の「該当なし」を null 返却で扱うために使う。
const PGRST_NO_ROWS = 'PGRST116';

const rowToCustomer = (row: CustomerRow): Customer =>
  Customer.reconstruct({
    id: row.id,
    authUserId: row.auth_user_id,
    name: row.name,
    email: row.email,
  });

// Phase 6 改定: customers の INSERT は handle_new_user トリガが受け持つため、
// このリポジトリは「読み取り専用」になる（save() 廃止）。
// SupabaseClient は composition-root で per-request に anon + JWT 付きで注入される
// 想定なので、このクラス自体は権限を意識せずに与えられた client をそのまま使う。
export class CustomerSupabaseRepository implements CustomerRepository {
  constructor(private readonly sb: SupabaseClient) {}

  async list(): Promise<Customer[]> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(SELECT_COLUMNS)
      .order('name', { ascending: true })
      .overrideTypes<CustomerRow[], { merge: false }>();

    if (error) {
      throw new Error(`Customer 一覧の取得に失敗しました: ${error.message}`);
    }

    return data.map(rowToCustomer);
  }

  async findByEmail(email: Email): Promise<Customer | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(SELECT_COLUMNS)
      .eq('email', email.value)
      .maybeSingle<CustomerRow>();

    if (error && error.code !== PGRST_NO_ROWS) {
      throw new Error(`Customer の検索（email）に失敗しました: ${error.message}`);
    }
    if (data === null) {
      return null;
    }

    return rowToCustomer(data);
  }

  async findByAuthUserId(authUserId: string): Promise<Customer | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(SELECT_COLUMNS)
      .eq('auth_user_id', authUserId)
      .maybeSingle<CustomerRow>();

    if (error && error.code !== PGRST_NO_ROWS) {
      throw new Error(`Customer の検索（auth_user_id）に失敗しました: ${error.message}`);
    }
    if (data === null) {
      return null;
    }

    return rowToCustomer(data);
  }
}
