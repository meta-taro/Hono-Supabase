import type { Cake } from '../domain/cake';
import type { ListCakesUseCase } from '../application/list-cakes.usecase';
import type { CreateCakeUseCase, CreateCakeInput } from '../application/create-cake.usecase';
import type { GetCakeUseCase } from '../application/get-cake.usecase';
import type { UpdateCakeStockUseCase } from '../application/update-cake-stock.usecase';
import {
  CAKE_SORT_FIELDS,
  DEFAULT_CAKE_SORT,
  type CakeFilter,
  type CakeListCursor,
} from '../domain/cake.repository';
import { decodeCursor, encodeCursor } from '@/shared/http/cursor';
import { canonicalizeSort, parseSortParam } from '@/shared/http/sort';
import { formatETag, parseIfMatch } from '@/shared/http/etag';
import { PreconditionRequiredError, ValidationError } from '@/shared/domain/errors';
import {
  CakeCursorSchema,
  type CakeResponse,
  type ListCakesQuery,
  type ListCakesResponse,
  type UpdateCakeStockRequest,
} from './cake.dto';

// ETag を伴う単一 Cake のレスポンス。
//   body は外向きの JSON、etag は version を包んだ Weak ETag 文字列。
//   ヘッダへの載せ替えは routes 層が行う（controller は HTTP に触れない）。
export interface CakeResponseWithETag {
  body: CakeResponse;
  etag: string;
}

// Controller の責務:
//   - UseCase を呼び出す（業務手順は知らない）
//   - domain Entity を Response DTO に変換する（VO の中身を外向きの形にほぐす）
//   - HTTP / Hono 固有の API には触れない（routes 層の仕事）
//
// この層を薄く保つ理由:
//   - routes 層が「OpenAPI 定義 + ハンドラ」で太りやすいため、
//     変換ロジックは controller に逃がしておくと routes が読みやすくなる。
//   - controller を関数の集合にすることで、テストでは個別関数だけを直接叩ける。

// 内部関数: domain Cake → Response DTO（VO の値を取り出すだけ）
const toCakeResponse = (cake: Cake): CakeResponse => ({
  id: cake.id.value,
  name: cake.name,
  price: cake.price.value,
  stock: cake.stock,
});

// クエリパラメータ → domain の CakeFilter（未指定キーは積まない）。
const buildFilter = (query: ListCakesQuery): CakeFilter => {
  const filter: CakeFilter = {};
  if (query.available !== undefined) filter.available = query.available === 'true';
  if (query.min_price !== undefined) filter.minPrice = query.min_price;
  if (query.max_price !== undefined) filter.maxPrice = query.max_price;
  if (query.q !== undefined) filter.nameSearch = query.q;
  return filter;
};

export interface CakeControllerDeps {
  listCakes: ListCakesUseCase;
  createCake: CreateCakeUseCase;
  getCake: GetCakeUseCase;
  updateCakeStock: UpdateCakeStockUseCase;
}

export const createCakeController = (deps: CakeControllerDeps) => ({
  // GET /v1/cakes
  //   sort / filter をクエリから組み立て、after（不透明カーソル）をデコード・検証して
  //   UseCase に渡し、返ってきた nextCursor を再エンコードしてレスポンスに載せる。
  //   - sort の許可フィールド検証・不正カーソルは ValidationError(400) を投げる。
  //   - カーソルは発行時の sort を埋め込んでおり、今回の sort と不一致なら 400
  //     （並びが変わるとキーセットの整合が壊れるため、続きを保証できない）。
  list: async (query: ListCakesQuery): Promise<ListCakesResponse> => {
    const sort = parseSortParam(query.sort, CAKE_SORT_FIELDS, DEFAULT_CAKE_SORT);
    const canonicalSort = canonicalizeSort(sort);
    const filter = buildFilter(query);

    if (
      filter.minPrice !== undefined &&
      filter.maxPrice !== undefined &&
      filter.minPrice > filter.maxPrice
    ) {
      throw new ValidationError('価格帯の指定が不正です', [
        { field: 'min_price', message: 'min_price は max_price 以下である必要があります' },
      ]);
    }

    let after: CakeListCursor | undefined;
    if (query.after) {
      const decoded = decodeCursor(query.after, CakeCursorSchema);
      if (decoded.sort !== canonicalSort) {
        throw new ValidationError('カーソルとソート条件が一致しません', [
          {
            field: 'after',
            message: 'sort を変更した場合は after を付けずに先頭ページから取得してください',
          },
        ]);
      }
      after = { sort, values: decoded.values, id: decoded.id };
    }

    const page = await deps.listCakes({ limit: query.limit, sort, filter, after });

    // nextCursor には今回の sort（正規形）を埋め込んで返す。
    const nextCursor = page.nextCursor
      ? encodeCursor({
          sort: canonicalSort,
          values: page.nextCursor.values,
          id: page.nextCursor.id,
        })
      : null;

    return {
      cakes: page.cakes.map(toCakeResponse),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
    };
  },

  // POST /v1/cakes
  // 入力は routes 側で Zod により検証済み。ここでは UseCase に流すだけ。
  create: async (input: CreateCakeInput): Promise<CakeResponse> => {
    const cake = await deps.createCake(input);
    return toCakeResponse(cake);
  },

  // GET /v1/cakes/:id
  //   単一取得（認証不要）。version を Weak ETag として一緒に返し、
  //   クライアントはこの ETag を PATCH の If-Match に使う（楽観ロック）。
  getById: async (id: string): Promise<CakeResponseWithETag> => {
    const cake = await deps.getCake({ cakeId: id });
    return { body: toCakeResponse(cake), etag: formatETag(cake.version) };
  },

  // PATCH /v1/cakes/:id（在庫更新・管理者専用）
  //   If-Match 必須。
  //     - ヘッダ欠落      → 428 PRECONDITION_REQUIRED（無条件上書きを許さない）
  //     - 形式不正        → 400 VALIDATION_ERROR（parseIfMatch が投げる）
  //     - 版不一致        → 412（UseCase が CakeVersionConflictError を投げる）
  //   成功時は採番後の version を新しい ETag として返す。
  updateStock: async (
    id: string,
    ifMatch: string | undefined,
    input: UpdateCakeStockRequest,
  ): Promise<CakeResponseWithETag> => {
    if (ifMatch === undefined || ifMatch.trim() === '') {
      throw new PreconditionRequiredError(
        '在庫更新には If-Match ヘッダ（GET で取得した ETag）が必要です',
      );
    }
    const expectedVersion = parseIfMatch(ifMatch);
    const cake = await deps.updateCakeStock({ cakeId: id, stock: input.stock, expectedVersion });
    return { body: toCakeResponse(cake), etag: formatETag(cake.version) };
  },
});

export type CakeController = ReturnType<typeof createCakeController>;
