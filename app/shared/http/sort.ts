import { ValidationError } from '@/shared/domain/errors';

// ---------------------------------------------------------------------------
// ソートパラメータのパーサ（リソース非依存・汎用）
//   `?sort=-price,name` 形式のクエリ文字列を構造化されたソートキー配列に変換する。
//   - 接頭辞 '-' は降順、無印（または '+'）は昇順。
//   - 許可フィールド（allowed）に無いもの・重複フィールドは ValidationError(400)。
//   - 未指定/空なら defaultSort を返す（API の既定の並び順は呼び出し側＝presentation が決める）。
//
//   なぜ shared/http に置くか:
//     cursor.ts と同じく「HTTP 入力の解釈」は複数リソース（cakes / orders …）で
//     再利用したい純粋関数。フィールド集合だけ呼び出し側がジェネリクスで縛る。
// ---------------------------------------------------------------------------

export type SortDirection = 'asc' | 'desc';

export interface SortKey<F extends string> {
  field: F;
  direction: SortDirection;
}

export const parseSortParam = <F extends string>(
  raw: string | undefined,
  allowed: readonly F[],
  defaultSort: readonly SortKey<F>[],
): SortKey<F>[] => {
  if (raw === undefined || raw.trim() === '') {
    return [...defaultSort];
  }

  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return [...defaultSort];
  }

  const seen = new Set<string>();
  const keys: SortKey<F>[] = [];
  for (const token of tokens) {
    const direction: SortDirection = token.startsWith('-') ? 'desc' : 'asc';
    const field = token.startsWith('-') || token.startsWith('+') ? token.slice(1) : token;

    if (!allowed.includes(field as F)) {
      throw new ValidationError('sort パラメータが不正です', [
        { field: 'sort', message: `'${field}' でのソートはできません` },
      ]);
    }
    if (seen.has(field)) {
      throw new ValidationError('sort パラメータが不正です', [
        { field: 'sort', message: `'${field}' が重複しています` },
      ]);
    }
    seen.add(field);
    keys.push({ field: field as F, direction });
  }
  return keys;
};

// ソートキー配列を正規形の文字列に戻す。
// カーソルへの埋め込み・「カーソル発行時の sort と今回の sort が一致するか」の
// 検証に使う（同じ並びでなければキーセットの整合が崩れるため）。
export const canonicalizeSort = <F extends string>(keys: readonly SortKey<F>[]): string =>
  keys.map((key) => (key.direction === 'desc' ? '-' : '') + key.field).join(',');
