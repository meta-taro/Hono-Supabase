import type { Cake } from '../domain/cake';
import { CakeId } from '../domain/cake-id.vo';
import type { CakeRepository } from '../domain/cake.repository';
import { CakeNotFoundError } from '../domain/cake.errors';

// UseCase の入力 DTO。プリミティブのみ（VO は外に見せない）。
export interface GetCakeInput {
  cakeId: string;
}

// 業務手順:
//   1. cakeId を VO 化（UUID 形式違反は InvalidCakeError → 400）
//   2. repository.findById で取得
//   3. 見つからなければ CakeNotFoundError → 404
//
// version は Cake が保持しているので、presentation 層が ETag として外向きに公開できる。
export const createGetCakeUseCase = (repo: CakeRepository) => {
  return async (input: GetCakeInput): Promise<Cake> => {
    const cakeId = CakeId.from(input.cakeId);
    const cake = await repo.findById(cakeId);
    if (cake === null) {
      throw new CakeNotFoundError(cakeId.value);
    }
    return cake;
  };
};

export type GetCakeUseCase = ReturnType<typeof createGetCakeUseCase>;
