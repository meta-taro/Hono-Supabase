import { describe, it, expect } from 'vitest';
import { createListCakesUseCase } from './list-cakes.usecase';
import { InMemoryCakeRepository } from './__test-helpers__/in-memory-cake.repository';
import { Cake } from '../domain/cake';

describe('listCakesUseCase', () => {
  it('リポジトリが空のときは空ページ（cakes=[]、nextCursor=null）を返す', async () => {
    const repo = new InMemoryCakeRepository();
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes({ limit: 20 });

    expect(result.cakes).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('保存件数が limit 以内なら全件返し nextCursor は null', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'モンブラン', price: 600, stock: 10 }));
    await repo.save(Cake.create({ name: 'ガトーショコラ', price: 700, stock: 5 }));
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes({ limit: 20 });

    // name 昇順（ガトーショコラ → モンブラン）
    expect(result.cakes.map((c) => c.name)).toEqual(['ガトーショコラ', 'モンブラン']);
    expect(result.nextCursor).toBeNull();
  });

  it('limit を超える件数があるとき、limit 件だけ返し nextCursor を発行する', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'A', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'B', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'C', price: 500, stock: 1 }));
    const listCakes = createListCakesUseCase(repo);

    const result = await listCakes({ limit: 2 });

    expect(result.cakes.map((c) => c.name)).toEqual(['A', 'B']);
    // nextCursor は返した最後の行（B）を指す
    expect(result.nextCursor?.name).toBe('B');
  });

  it('nextCursor を after に渡すと続きのページを返す', async () => {
    const repo = new InMemoryCakeRepository();
    await repo.save(Cake.create({ name: 'A', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'B', price: 500, stock: 1 }));
    await repo.save(Cake.create({ name: 'C', price: 500, stock: 1 }));
    const listCakes = createListCakesUseCase(repo);

    const first = await listCakes({ limit: 2 });
    const second = await listCakes({ limit: 2, after: first.nextCursor ?? undefined });

    expect(second.cakes.map((c) => c.name)).toEqual(['C']);
    expect(second.nextCursor).toBeNull();
  });

  it('同名ケーキが境界をまたいでも取りこぼし・重複なくページングできる', async () => {
    // name が一意でない前提を検証する。複合キー (name, id) でなければ
    // 同名行の途中でページが切れたとき重複 or 欠落が起きる。
    const repo = new InMemoryCakeRepository();
    const sameName = 'チーズケーキ';
    for (let i = 0; i < 5; i += 1) {
      await repo.save(Cake.create({ name: sameName, price: 500, stock: 1 }));
    }
    const listCakes = createListCakesUseCase(repo);

    const collected: string[] = [];
    let after = undefined as { name: string; id: string } | undefined;
    // 2 件ずつ全ページを舐める
    for (let page = 0; page < 10; page += 1) {
      const res = await listCakes({ limit: 2, after });
      collected.push(...res.cakes.map((c) => c.id.value));
      if (!res.nextCursor) break;
      after = res.nextCursor;
    }

    // 5 件すべてが重複なく 1 回ずつ取得できている
    expect(new Set(collected).size).toBe(5);
    expect(collected).toHaveLength(5);
  });
});
