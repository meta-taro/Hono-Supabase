import type { Cake } from '../domain/cake';
import type { ListCakesUseCase } from '../application/list-cakes.usecase';
import type { CreateCakeUseCase, CreateCakeInput } from '../application/create-cake.usecase';
import { decodeCursor, encodeCursor } from '@/shared/http/cursor';
import {
  CakeCursorSchema,
  type CakeResponse,
  type ListCakesQuery,
  type ListCakesResponse,
} from './cake.dto';

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

export interface CakeControllerDeps {
  listCakes: ListCakesUseCase;
  createCake: CreateCakeUseCase;
}

export const createCakeController = (deps: CakeControllerDeps) => ({
  // GET /v1/cakes
  //   after（不透明カーソル）をデコード・検証して UseCase に渡し、
  //   返ってきた nextCursor を再エンコードしてレスポンスに載せる。
  //   不正・改竄カーソルは decodeCursor が ValidationError(400) を投げる。
  list: async (query: ListCakesQuery): Promise<ListCakesResponse> => {
    const after = query.after ? decodeCursor(query.after, CakeCursorSchema) : undefined;
    const page = await deps.listCakes({ limit: query.limit, after });
    const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;
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
});

export type CakeController = ReturnType<typeof createCakeController>;
