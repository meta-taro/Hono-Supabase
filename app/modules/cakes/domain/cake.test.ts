import { describe, it, expect } from 'vitest';
import { Cake } from './cake';
import { CakeId } from './cake-id.vo';
import { Price } from './price.vo';
import { InvalidCakeError, InvalidPriceError } from './cake.errors';

describe('Cake.create', () => {
  it('正しい入力で Cake を生成し、ID は自動採番される', () => {
    const cake = Cake.create({ name: 'モンブラン', price: 600, stock: 10 });
    expect(cake.id).toBeInstanceOf(CakeId);
    expect(cake.name).toBe('モンブラン');
    expect(cake.price).toBeInstanceOf(Price);
    expect(cake.price.value).toBe(600);
    expect(cake.stock).toBe(10);
  });

  it('新規生成の version は 1（DB の default と一致）', () => {
    const cake = Cake.create({ name: 'モンブラン', price: 600, stock: 10 });
    expect(cake.version).toBe(1);
  });

  it('name は前後の空白がトリムされる', () => {
    const cake = Cake.create({ name: '  ガトーショコラ  ', price: 700, stock: 5 });
    expect(cake.name).toBe('ガトーショコラ');
  });

  it('name 空文字を拒否する', () => {
    expect(() => Cake.create({ name: '', price: 600, stock: 1 })).toThrow(InvalidCakeError);
  });

  it('name 空白のみを拒否する', () => {
    expect(() => Cake.create({ name: '   ', price: 600, stock: 1 })).toThrow(InvalidCakeError);
  });

  it('name 100 文字超を拒否する', () => {
    const longName = 'あ'.repeat(101);
    expect(() => Cake.create({ name: longName, price: 600, stock: 1 })).toThrow(InvalidCakeError);
  });

  it('stock がマイナスなら拒否する', () => {
    expect(() => Cake.create({ name: 'a', price: 600, stock: -1 })).toThrow(InvalidCakeError);
  });

  it('stock が小数なら拒否する', () => {
    expect(() => Cake.create({ name: 'a', price: 600, stock: 1.5 })).toThrow(InvalidCakeError);
  });

  it('price が不正なら Price の例外が伝播する', () => {
    expect(() => Cake.create({ name: 'a', price: 0, stock: 1 })).toThrow(InvalidPriceError);
  });

  it('生成された ID はそれぞれユニーク', () => {
    const a = Cake.create({ name: 'a', price: 100, stock: 1 });
    const b = Cake.create({ name: 'b', price: 100, stock: 1 });
    expect(a.id.value).not.toBe(b.id.value);
  });
});

describe('Cake.reconstruct', () => {
  it('永続化層からの値で Cake を復元する', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const cake = Cake.reconstruct({ id, name: 'モンブラン', price: 600, stock: 10, version: 3 });
    expect(cake.id.value).toBe(id);
    expect(cake.name).toBe('モンブラン');
    expect(cake.price.value).toBe(600);
    expect(cake.stock).toBe(10);
    expect(cake.version).toBe(3);
  });

  it('壊れた id では復元できない', () => {
    expect(() =>
      Cake.reconstruct({ id: 'not-uuid', name: 'a', price: 100, stock: 1, version: 1 }),
    ).toThrow(InvalidCakeError);
  });

  it('壊れた price では復元できない（Fail-Fast）', () => {
    expect(() =>
      Cake.reconstruct({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'a',
        price: 0,
        stock: 1,
        version: 1,
      }),
    ).toThrow(InvalidPriceError);
  });
});

describe('Cake.changeStock', () => {
  const base = (): Cake =>
    Cake.reconstruct({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'モンブラン',
      price: 600,
      stock: 10,
      version: 4,
    });

  it('在庫を更新した新しい Cake を返す（元インスタンスは不変）', () => {
    const cake = base();
    const updated = cake.changeStock(50);
    expect(updated.stock).toBe(50);
    expect(cake.stock).toBe(10); // 元は変わらない（イミュータブル）
  });

  it('id / name / price は引き継ぐ', () => {
    const updated = base().changeStock(0);
    expect(updated.id.value).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(updated.name).toBe('モンブラン');
    expect(updated.price.value).toBe(600);
  });

  it('version は据え置く（採番は永続化層=DB トリガの責務）', () => {
    const updated = base().changeStock(50);
    expect(updated.version).toBe(4);
  });

  it('在庫 0 は許可する（在庫切れは正当な状態）', () => {
    expect(() => base().changeStock(0)).not.toThrow();
  });

  it('在庫が負なら拒否する', () => {
    expect(() => base().changeStock(-1)).toThrow(InvalidCakeError);
  });

  it('在庫が小数なら拒否する', () => {
    expect(() => base().changeStock(1.5)).toThrow(InvalidCakeError);
  });
});
