import { describe, it, expect } from 'vitest';
import { canonicalizeSort, parseSortParam, type SortKey } from './sort';
import { ValidationError } from '@/shared/domain/errors';

const ALLOWED = ['name', 'price', 'stock'] as const;
type Field = (typeof ALLOWED)[number];
const DEFAULT: SortKey<Field>[] = [{ field: 'name', direction: 'asc' }];

describe('parseSortParam', () => {
  it('未指定なら defaultSort を返す', () => {
    expect(parseSortParam(undefined, ALLOWED, DEFAULT)).toEqual(DEFAULT);
  });

  it('空文字・空白のみなら defaultSort を返す', () => {
    expect(parseSortParam('', ALLOWED, DEFAULT)).toEqual(DEFAULT);
    expect(parseSortParam('   ', ALLOWED, DEFAULT)).toEqual(DEFAULT);
  });

  it('無印フィールドは昇順', () => {
    expect(parseSortParam('name', ALLOWED, DEFAULT)).toEqual([{ field: 'name', direction: 'asc' }]);
  });

  it('接頭辞 - は降順', () => {
    expect(parseSortParam('-price', ALLOWED, DEFAULT)).toEqual([
      { field: 'price', direction: 'desc' },
    ]);
  });

  it('接頭辞 + は昇順（明示）', () => {
    expect(parseSortParam('+stock', ALLOWED, DEFAULT)).toEqual([
      { field: 'stock', direction: 'asc' },
    ]);
  });

  it('複数フィールドを順序どおりにパースする', () => {
    expect(parseSortParam('-price,name', ALLOWED, DEFAULT)).toEqual([
      { field: 'price', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('トークン前後の空白を無視する', () => {
    expect(parseSortParam(' -price , name ', ALLOWED, DEFAULT)).toEqual([
      { field: 'price', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('許可されていないフィールドは ValidationError(400)', () => {
    expect(() => parseSortParam('created_at', ALLOWED, DEFAULT)).toThrow(ValidationError);
  });

  it('同じフィールドの重複は ValidationError（向き違いでも）', () => {
    expect(() => parseSortParam('name,name', ALLOWED, DEFAULT)).toThrow(ValidationError);
    expect(() => parseSortParam('-name,name', ALLOWED, DEFAULT)).toThrow(ValidationError);
  });
});

describe('canonicalizeSort', () => {
  it('ソートキー配列を正規形の文字列に戻す（降順は - 付き）', () => {
    expect(
      canonicalizeSort<Field>([
        { field: 'price', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ]),
    ).toBe('-price,name');
  });

  it('parse → canonicalize で往復一致する', () => {
    const raw = '-price,name';
    expect(canonicalizeSort(parseSortParam(raw, ALLOWED, DEFAULT))).toBe(raw);
  });
});
