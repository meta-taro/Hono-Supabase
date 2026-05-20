import type { CakePage, CakeRepository, ListCakesParams } from '../domain/cake.repository';

// UseCase = アプリケーションサービス。業務手順を 1 つだけ持つ。
// ファクトリ関数で Repository を受け取る（手動 DI）。
// クラスにせず関数で公開するのは、テストでモック差し替えがしやすいため。
//
// ページネーションのキーセット計算は Repository（永続化の都合を知る層）に委ね、
// ここでは「パラメータをそのまま渡して 1 ページ受け取る」薄い手順に保つ。
export const createListCakesUseCase = (repo: CakeRepository) => {
  return async (params: ListCakesParams): Promise<CakePage> => {
    return repo.list(params);
  };
};

export type ListCakesUseCase = ReturnType<typeof createListCakesUseCase>;
