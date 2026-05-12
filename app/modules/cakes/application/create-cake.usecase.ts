import type { AppLogger } from '@/shared/infrastructure/logger';
import { Cake } from '../domain/cake';
import type { CakeRepository } from '../domain/cake.repository';

// UseCase の入力 DTO。プリミティブ型のみ（domain VO は外部から見せない）。
export interface CreateCakeInput {
  name: string;
  price: number;
  stock: number;
}

// 業務手順:
//   1. Cake.create() で不変条件を満たした Entity を生成（壊れた入力はここで弾かれる）
//   2. Repository に永続化
//   3. ビジネスイベントとして info ログ
export const createCreateCakeUseCase = (repo: CakeRepository, logger: AppLogger) => {
  return async (input: CreateCakeInput): Promise<Cake> => {
    const cake = Cake.create(input);
    await repo.save(cake);
    logger.info({ cakeId: cake.id.value, name: cake.name }, 'Cake created');
    return cake;
  };
};

export type CreateCakeUseCase = ReturnType<typeof createCreateCakeUseCase>;
