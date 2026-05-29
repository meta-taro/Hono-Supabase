import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { ReviewId } from '@/modules/reviews/domain/review-id.vo';
import type {
  ReviewListCursor,
  ReviewSortOption,
  ReviewStats,
} from '@/modules/reviews/domain/review.repository';
import { ShopReview } from '@/modules/reviews/domain/shop-review';
import { ShopReviewAlreadyExistsError } from '@/modules/reviews/domain/shop-review.errors';
import type {
  ListShopReviewsParams,
  ShopReviewPage,
  ShopReviewRepository,
} from '@/modules/reviews/domain/shop-review.repository';
import { ConflictError } from '@/shared/domain/errors';

// DB 行の型。domain の ShopReview と独立させる（DB の都合 = snake_case や timestamptz の
// ISO 文字列表現 = が domain 層に漏れないようにするため）。
interface ShopReviewRow {
  id: string;
  user_id: string;
  rating: number;
  title: string;
  body: string;
  status: string;
  is_verified_customer: boolean;
  helpful_count: number;
  flag_count: number;
  created_at: string; // timestamptz は ISO 文字列で来る
  updated_at: string;
}

// shop_review_stats RPC の戻り値（jsonb）。
interface ReviewStatsJson {
  count: number;
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

const TABLE_NAME = 'shop_reviews';
const SHOP_REVIEW_COLUMNS =
  'id, user_id, rating, title, body, status, is_verified_customer, helpful_count, flag_count, created_at, updated_at';

// Postgres エラーコード（PostgREST が error.code に転載する）。
const PG_UNIQUE_VIOLATION = '23505';

// 店舗レビュー重複投稿用の partial unique index 名（migration 0010 と一致させる）。
const SHOP_REVIEWS_ACTIVE_UNIQ_INDEX = 'shop_reviews_active_uniq_idx';

// PostgREST のフィルタ値（タイムスタンプ・UUID）に予約文字が混ざっても
// `or(...)` の構文を壊さないよう、ダブルクォートで囲んで \ と " をエスケープする。
const pgrstQuoteValue = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// 数値は引用なし、文字列は引用ありで PostgREST フィルタ値に整形する。
const formatKeysetValue = (value: string | number): string =>
  typeof value === 'number' ? String(value) : pgrstQuoteValue(value);

export class ShopReviewSupabaseRepository implements ShopReviewRepository {
  // SupabaseClient は composition-root で per-request 注入される。
  // - 公開 GET は anon クライアントでも shop_reviews_select_published policy で読める。
  // - POST は authenticated + auth.uid() = user_id policy で本人のみ insert 可。
  constructor(private readonly sb: SupabaseClient) {}

  async save(review: ShopReview): Promise<void> {
    const { error } = await this.sb.from(TABLE_NAME).insert({
      id: review.id.value,
      user_id: review.userId,
      rating: review.rating.value,
      title: review.title,
      body: review.body,
      status: review.status,
      is_verified_customer: review.isVerifiedCustomer,
      helpful_count: review.helpfulCount,
      flag_count: review.flagCount,
    });

    if (!error) return;

    // 重複投稿（partial unique index 違反）はドメイン例外に翻訳する。
    // UseCase 側でも事前に existsActiveByUser でチェックしているが、
    // 並行投稿で先に DB に書かれた場合の競合をここでも捕まえる（多重防御）。
    if (
      error.code === PG_UNIQUE_VIOLATION &&
      error.message.includes(SHOP_REVIEWS_ACTIVE_UNIQ_INDEX)
    ) {
      throw new ShopReviewAlreadyExistsError(review.userId);
    }

    // それ以外の unique 違反（id 衝突など）は ConflictError に倒す。
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError(`ShopReview (id=${review.id.value}) は既に登録されています`);
    }

    throw new Error(`ShopReview の保存に失敗しました: ${error.message}`);
  }

  async findById(id: ReviewId): Promise<ShopReview | null> {
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select(SHOP_REVIEW_COLUMNS)
      .eq('id', id.value)
      .maybeSingle<ShopReviewRow>();

    if (error) {
      throw new Error(`ShopReview の取得に失敗しました: ${error.message}`);
    }
    return data ? this.toReview(data) : null;
  }

  async list(params: ListShopReviewsParams): Promise<ShopReviewPage> {
    let query = this.sb
      .from(TABLE_NAME)
      .select(SHOP_REVIEW_COLUMNS)
      // RLS の published policy に合わせて明示的に絞り込む（多重防御）。
      // service_role 経路でも published 以外は返さない。
      .eq('status', 'published');

    if (params.filterRating !== undefined) {
      query = query.eq('rating', params.filterRating);
    }
    if (params.verifiedOnly === true) {
      query = query.eq('is_verified_customer', true);
    }

    // キーセット: ORDER BY と同じ並びの「続き」だけに絞る。
    // newest:  created_at DESC, id DESC
    // helpful: helpful_count DESC, created_at DESC, id DESC
    if (params.after) {
      query = query.or(buildKeysetOr(params.sort, params.after));
    }

    if (params.sort === 'helpful') {
      query = query.order('helpful_count', { ascending: false });
    }
    query = query.order('created_at', { ascending: false }).order('id', { ascending: false });

    const { data, error } = await query
      .limit(params.limit + 1)
      .overrideTypes<ShopReviewRow[], { merge: false }>();

    if (error) {
      throw new Error(`ShopReview 一覧の取得に失敗しました: ${error.message}`);
    }

    const hasMore = data.length > params.limit;
    const rows = hasMore ? data.slice(0, params.limit) : data;
    const reviews = rows.map((row) => this.toReview(row));

    const last = rows[rows.length - 1];
    const nextCursor: ReviewListCursor | null =
      hasMore && last
        ? {
            sort: params.sort,
            createdAt: last.created_at,
            id: last.id,
            ...(params.sort === 'helpful' ? { helpfulCount: last.helpful_count } : {}),
          }
        : null;

    return { reviews, nextCursor };
  }

  async stats(): Promise<ReviewStats> {
    // shop_review_stats RPC で count / average / 星別 distribution を 1 クエリで取得する。
    // 店舗単位（単一店舗）なのでパラメータは無い。
    const { data, error } = (await this.sb.rpc('shop_review_stats')) as {
      data: ReviewStatsJson | null;
      error: PostgrestError | null;
    };

    if (error) {
      throw new Error(`ShopReview 集計の取得に失敗しました: ${error.message}`);
    }

    // RPC は 0 件でも { count:0, average:null, distribution:{...0..} } を返す設計。
    // null になるケースは想定外（RPC が落ちている）なので明示的に 0 件として扱う。
    if (data === null) {
      return { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    }

    return {
      count: data.count,
      average: data.average,
      distribution: {
        1: data.distribution['1'],
        2: data.distribution['2'],
        3: data.distribution['3'],
        4: data.distribution['4'],
        5: data.distribution['5'],
      },
    };
  }

  async existsActiveByUser(userId: string): Promise<boolean> {
    // partial unique index と同じ条件: published / hidden のレビューが 1 件でもあれば true。
    // RLS で本人のみ自分の hidden レビューが見える → 自分の重複投稿チェックは authenticated
    // 経路で正しく機能する。published は anon でも見えるため誰でも検出可能。
    const { data, error } = await this.sb
      .from(TABLE_NAME)
      .select('id')
      .eq('user_id', userId)
      .neq('status', 'removed')
      .limit(1);

    if (error) {
      throw new Error(`ShopReview 重複判定に失敗しました: ${error.message}`);
    }
    return data.length > 0;
  }

  // ShopReviewRow → domain の ShopReview へ復元する。必ず reconstruct 経由で
  // 不変条件（UUID 形式 / rating 範囲 / status enum）を DB 由来データにも適用する。
  private toReview(row: ShopReviewRow): ShopReview {
    return ShopReview.reconstruct({
      id: row.id,
      userId: row.user_id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      status: row.status,
      isVerifiedCustomer: row.is_verified_customer,
      helpfulCount: row.helpful_count,
      flagCount: row.flag_count,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }
}

// -----------------------------------------------------------------------------
// 多カラムキーセットの「after より厳密に後ろ」を表す or(...) 式を組み立てる。
//
//   newest (created_at DESC, id DESC):
//     created_at.lt.<X> OR and(created_at.eq.<X>, id.lt.<Y>)
//
//   helpful (helpful_count DESC, created_at DESC, id DESC):
//     helpful_count.lt.<H>
//     OR and(helpful_count.eq.<H>, created_at.lt.<X>)
//     OR and(helpful_count.eq.<H>, created_at.eq.<X>, id.lt.<Y>)
// -----------------------------------------------------------------------------
const buildKeysetOr = (sort: ReviewSortOption, after: ReviewListCursor): string => {
  const createdAt = pgrstQuoteValue(after.createdAt);
  const id = pgrstQuoteValue(after.id);

  if (sort === 'newest') {
    return [`created_at.lt.${createdAt}`, `and(created_at.eq.${createdAt},id.lt.${id})`].join(',');
  }

  // helpful: helpfulCount はカーソルに必ず載っているはず（domain で sort=helpful のみ含める）。
  const helpful = formatKeysetValue(after.helpfulCount ?? 0);
  return [
    `helpful_count.lt.${helpful}`,
    `and(helpful_count.eq.${helpful},created_at.lt.${createdAt})`,
    `and(helpful_count.eq.${helpful},created_at.eq.${createdAt},id.lt.${id})`,
  ].join(',');
};
