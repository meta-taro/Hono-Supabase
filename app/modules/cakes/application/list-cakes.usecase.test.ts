import { describe, it, expect } from 'vitest';
import { createListCakesUseCase } from './list-cakes.usecase';
import { InMemoryCakeRepository } from './__test-helpers__/in-memory-cake.repository';
import { Cake } from '../domain/cake';
import {
  DEFAULT_CAKE_SORT,
  type CakeSortKey,
  type ListCakesParams,
} from '../domain/cake.repository';

const BY_NAME = [...DEFAULT_CAKE_SORT];
const NO_FILTER = {};

// limit / sort / filter / after の定型を埋める薄いヘルパ。
const params = (over: Partial<ListCakesParams>): ListCakesParams => ({
  limit: 20,
  sort: BY_NAME,
  filter: NO_FILTER,
  ...over,
});

// 固定 id でケーキを復元する（多カラムソート・id tiebreaker の決定的検証用）。
const seed = (id: string, name: string, price: number, stock: number): Cake =>
  Cake.reconstruct({ id, name, price, stock, version: 1 });

const oid = (suffix: string): string => `${suffix}-0000-4000-8000-000000000000`;

describe('listCakesUseCase', () => {
  it('リポジトリが空のときは空ページ（cakes=[]、nextCursor=null）を返す', async () => {
    const repo = new InMemoryCakeRepository();
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes(params({}));

    expect(result.cakes).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('保存件数が limit 以内なら全件返し nextCursor は null（既定: name 昇順）', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'モンブラン', price: 600, stock: 10 }));
    await repo.save(Cake.create({ name: 'ガトーショコラ', price: 700, stock: 5 }));
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes(params({}));

    expect(result.cakes.map((c) => c.name)).toEqual(['ガトーショコラ', 'モンブラン']);
    expect(result.nextCursor).toBeNull();
  });

  it('limit を超える件数があるとき、limit 件だけ返し nextCursor を発行する', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'A', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'B', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'C', price: 500, stock: 1 }));
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes(params({ limit: 2 }));

    expect(result.cakes.map((c) => c.name)).toEqual(['A', 'B']);
    // nextCursor は返した最後の行（B）の sort フィールド値を指す
    expect(result.nextCursor?.values.name).toBe('B');
  });

  it('nextCursor を after に渡すと続きのページを返す', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'A', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'B', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'C', price: 500, stock: 1 }));
    const listCakes = createListCakesUseCase(repo);

    const first = await listCakes(params({ limit: 2 }));
    const second = await listCakes(params({ limit: 2, after: first.nextCursor ?? undefined }));

    expect(second.cakes.map((c) => c.name)).toEqual(['C']);
    expect(second.nextCursor).toBeNull();
  });

  it('同名ケーキが境界をまたいでも取りこぼし・重複なくページングできる', async () => {
    const repo = new InMemoryCakeRepository();
    const sameName = 'チーズケーキ';
    for (let i = 0; i < 5; i += 1) {
      await repo.save(Cake.create({ name: sameName, price: 500, stock: 1 }));
    }
    const listCakes = createListCakesUseCase(repo);

    const collected: string[] = [];
    let after = undefined as ListCakesParams['after'];
    for (let page = 0; page < 10; page += 1) {
      const res = await listCakes(params({ limit: 2, after }));
      collected.push(...res.cakes.map((c) => c.id.value));
      if (!res.nextCursor) break;
      after = res.nextCursor;
    }

    expect(new Set(collected).size).toBe(5);
    expect(collected).toHaveLength(5);
  });

  describe('ソート', () => {
    const byPriceDesc: CakeSortKey[] = [{ field: 'price', direction: 'desc' }];

    it('price 降順で並べ替える', async () => {
      const repo = new InMemoryCakeRepository();
      await repo.save(seed(oid('a0000001'), 'A', 500, 1));
      await repo.save(seed(oid('a0000002'), 'B', 900, 1));
      await repo.save(seed(oid('a0000003'), 'C', 700, 1));
      const listCakes = createListCakesUseCase(repo);

      const result = await listCakes(params({ sort: byPriceDesc }));

      expect(result.cakes.map((c) => c.price.value)).toEqual([900, 700, 500]);
    });

    it('price 同値のときは id 昇順で安定ソートする', async () => {
      const repo = new InMemoryCakeRepository();
      await repo.save(seed(oid('a0000003'), 'C', 500, 1));
      await repo.save(seed(oid('a0000001'), 'A', 500, 1));
      await repo.save(seed(oid('a0000002'), 'B', 500, 1));
      const listCakes = createListCakesUseCase(repo);

      const result = await listCakes(params({ sort: byPriceDesc }));

      // price 同値 → id 昇順 tiebreaker
      expect(result.cakes.map((c) => c.id.value)).toEqual([
        oid('a0000001'),
        oid('a0000002'),
        oid('a0000003'),
      ]);
    });

    it('price 降順のカーソルでページを跨いでも順序を保つ', async () => {
      const repo = new InMemoryCakeRepository();
      await repo.save(seed(oid('a0000001'), 'A', 500, 1));
      await repo.save(seed(oid('a0000002'), 'B', 900, 1));
      await repo.save(seed(oid('a0000003'), 'C', 700, 1));
      const listCakes = createListCakesUseCase(repo);

      const page1 = await listCakes(params({ limit: 2, sort: byPriceDesc }));
      expect(page1.cakes.map((c) => c.price.value)).toEqual([900, 700]);
      expect(page1.nextCursor?.values.price).toBe(700);

      const page2 = await listCakes(
        params({ limit: 2, sort: byPriceDesc, after: page1.nextCursor ?? undefined }),
      );
      expect(page2.cakes.map((c) => c.price.value)).toEqual([500]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe('フィルタ', () => {
    const buildRepo = async (): Promise<InMemoryCakeRepository> => {
      const repo = new InMemoryCakeRepository();
      await repo.save(seed(oid('a0000001'), 'いちごタルト', 500, 0));
      await repo.save(seed(oid('a0000002'), 'ガトーショコラ', 700, 3));
      await repo.save(seed(oid('a0000003'), 'いちごショート', 480, 10));
      return repo;
    };

    it('available=true は在庫ありだけ返す', async () => {
      const listCakes = createListCakesUseCase(await buildRepo());
      const result = await listCakes(params({ filter: { available: true } }));
      expect(result.cakes.map((c) => c.name).sort()).toEqual(['いちごショート', 'ガトーショコラ']);
    });

    it('available=false は在庫切れだけ返す', async () => {
      const listCakes = createListCakesUseCase(await buildRepo());
      const result = await listCakes(params({ filter: { available: false } }));
      expect(result.cakes.map((c) => c.name)).toEqual(['いちごタルト']);
    });

    it('minPrice / maxPrice で価格帯を絞る（両端含む）', async () => {
      const listCakes = createListCakesUseCase(await buildRepo());
      const result = await listCakes(params({ filter: { minPrice: 480, maxPrice: 500 } }));
      expect(result.cakes.map((c) => c.price.value).sort()).toEqual([480, 500]);
    });

    it('nameSearch は検索語でフィルタする（in-memory は部分一致で近似）', async () => {
      const listCakes = createListCakesUseCase(await buildRepo());
      const result = await listCakes(params({ filter: { nameSearch: 'いちご' } }));
      expect(result.cakes.map((c) => c.name).sort()).toEqual(['いちごショート', 'いちごタルト']);
    });

    it('フィルタとソートとページネーションを同時に適用する', async () => {
      const listCakes = createListCakesUseCase(await buildRepo());
      const result = await listCakes(
        params({
          limit: 1,
          sort: [{ field: 'price', direction: 'asc' }],
          filter: { available: true },
        }),
      );
      // 在庫あり 2 件のうち price 昇順 1 件目 = いちごショート(480)
      expect(result.cakes.map((c) => c.name)).toEqual(['いちごショート']);
      expect(result.nextCursor?.values.price).toBe(480);
    });
  });
});
