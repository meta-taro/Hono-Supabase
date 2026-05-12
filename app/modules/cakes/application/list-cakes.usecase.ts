import type { Cake } from '../domain/cake';
import type { CakeRepository } from '../domain/cake.repository';

// UseCase = アプリケーションサービス。業務手順を 1 つだけ持つ。
// ファクトリ関数で Repository を受け取る（手動 DI）。
// クラスにせず関数で公開するのは、テストでモック差し替えがしやすいため。
export const createListCakesUseCase = (repo: CakeRepository) => {
  return async (): Promise<Cake[]> => {
    return repo.list();
  };
};

export type ListCakesUseCase = ReturnType<typeof createListCakesUseCase>;
