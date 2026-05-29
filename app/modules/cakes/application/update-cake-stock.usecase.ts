import type { AppLogger } from '@/shared/infrastructure/logger';
import type { Cake } from '../domain/cake';
import { CakeId } from '../domain/cake-id.vo';
import type { CakeRepository } from '../domain/cake.repository';
import { CakeNotFoundError, CakeVersionConflictError } from '../domain/cake.errors';

// UseCase の入力 DTO。
//   expectedVersion … クライアントが If-Match で提示した「自分が見た版」。
//                      この版のままなら更新を通し、進んでいたら 412 で弾く（楽観ロック）。
export interface UpdateCakeStockInput {
  cakeId: string;
  stock: number;
  expectedVersion: number;
}

// 業務手順:
//   1. cakeId を VO 化（UUID 違反は InvalidCakeError → 400）
//   2. findById で現在の Cake を取得（無ければ CakeNotFoundError → 404）
//   3. cake.changeStock(stock) で在庫の不変条件を検証（負値・小数は InvalidCakeError → 400）
//   4. repository.updateStock で「version 一致時のみ」原子的に更新
//      - null（版が進んでいた / 行が消えた）なら CakeVersionConflictError → 412
//
// なぜ findById してから version 付き UPDATE するのか:
//   - 404（そもそも無い）と 412（版が進んだ）を取り違えないため、まず存在を確認する。
//   - 競合の最終判定は DB の `WHERE version = expectedVersion`（原子的）に委ね、
//     findById 〜 updateStock 間に割り込まれても lost update を起こさない。
export const createUpdateCakeStockUseCase = (repo: CakeRepository, logger: AppLogger) => {
  return async (input: UpdateCakeStockInput): Promise<Cake> => {
    const cakeId = CakeId.from(input.cakeId);

    const current = await repo.findById(cakeId);
    if (current === null) {
      throw new CakeNotFoundError(cakeId.value);
    }

    // 在庫値の検証を domain に委ねる（戻り値は version 据え置きの新インスタンス）。
    const desired = current.changeStock(input.stock);

    const updated = await repo.updateStock(cakeId, desired.stock, input.expectedVersion);
    if (updated === null) {
      // findById では存在したのに更新できなかった = version が進んでいる（競合）。
      logger.warn(
        { cakeId: cakeId.value, expectedVersion: input.expectedVersion },
        'Cake stock update conflict (stale version)',
      );
      throw new CakeVersionConflictError(cakeId.value);
    }

    logger.info(
      { cakeId: cakeId.value, stock: updated.stock, version: updated.version },
      'Cake stock updated',
    );
    return updated;
  };
};

export type UpdateCakeStockUseCase = ReturnType<typeof createUpdateCakeStockUseCase>;
