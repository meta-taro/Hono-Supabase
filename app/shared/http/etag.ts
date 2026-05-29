import { ValidationError } from '@/shared/domain/errors';

// ---------------------------------------------------------------------------
// ETag / If-Match ユーティリティ（楽観ロック用。Phase 10 Step 4）
//
//   本 API の ETag は「リソースの version 整数」を不透明トークンとして包んだもの。
//   キャッシュ用途ではなく、更新競合検知（If-Match → 412）に使う。
//
//   形式は Weak ETag（`W/"<version>"`）。version 番号は「意味的に同じ版」を表すが
//   バイト単位の同一性までは保証しない（=弱い検証子）ので weak が適切。
//
//   なぜ素の数値 ETag（`7`）ではなく version を包むのか:
//     ETag はクライアントから見て不透明であるべき（中身の意味に依存させない）。
//     将来 version をハッシュや複合キーに変えても、クライアントは
//     「GET で得た ETag をそのまま If-Match に返す」だけで動き続けられる。
// ---------------------------------------------------------------------------

// version を Weak ETag 文字列にする。GET / 更新レスポンスの ETag ヘッダに載せる。
export const formatETag = (version: number): string => `W/"${String(version)}"`;

// `W/"7"` または `"7"` の引用符内が「非負整数」かどうかを判定する正規表現。
// 先頭の `W/` は任意。中身は 1 桁以上の数字のみ（負号・小数点・空は弾く）。
const IF_MATCH_PATTERN = /^(?:W\/)?"(\d+)"$/;

// If-Match ヘッダ値から version 整数を取り出す。
//   - `W/"7"` / `"7"` → 7
//   - 形式不正（裸の数字・`*`・非数字・空）は ValidationError(400)。
//     ヘッダ自体が無い（=未提示）ケースは呼び出し側で 428 に振り分ける責務とし、
//     ここでは「値はあるが壊れている」入力だけを 400 として扱う。
export const parseIfMatch = (header: string): number => {
  const match = IF_MATCH_PATTERN.exec(header.trim());
  if (!match) {
    throw new ValidationError('If-Match ヘッダの形式が不正です', [
      { field: 'If-Match', message: 'W/"<version>" 形式（GET で得た ETag）を指定してください' },
    ]);
  }
  // \d+ にマッチした時点で安全に整数化できる（NaN は起きない）。
  return Number(match[1]);
};
