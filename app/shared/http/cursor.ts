import type { z } from 'zod';
import { ValidationError } from '@/shared/domain/errors';

// ---------------------------------------------------------------------------
// 不透明（opaque）カーソルコーデック
//   カーソルベースのページネーションで使う「次ページ位置」を、クライアントが
//   中身を解釈しなくてよい 1 トークン（base64url 文字列）に包む / 解く。
//
//   なぜ TextEncoder/TextDecoder を挟むか:
//     btoa / atob は Latin1（1 バイト文字）しか扱えず、日本語（ケーキ名）を
//     直接渡すと文字化け・例外になる。UTF-8 バイト列へ正規化してから base64 する。
//     Cloudflare Workers には Node の Buffer が無いため Web 標準 API のみで完結させる。
// ---------------------------------------------------------------------------

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  // base64 → base64url（URL/クエリ文字列にそのまま載せられる形）。
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64); // 不正な base64 はここで DOMException を投げる
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// ペイロード（JSON シリアライズ可能な任意の値）を不透明カーソルにエンコードする。
export const encodeCursor = (payload: unknown): string => {
  const json = JSON.stringify(payload);
  return toBase64Url(new TextEncoder().encode(json));
};

// カーソルをデコードし、与えた Zod スキーマで中身を検証して返す。
// デコード不能・JSON 不正・スキーマ不一致（=改竄や旧バージョンのカーソル）は
// すべて ValidationError(400) に倒す。500 にしないのはクライアント起因の入力だから。
export const decodeCursor = <T>(raw: string, schema: z.ZodType<T>): T => {
  let parsed: unknown;
  try {
    const json = new TextDecoder().decode(fromBase64Url(raw));
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError('カーソルの形式が不正です', [
      { field: 'after', message: 'カーソルをデコードできませんでした' },
    ]);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError('カーソルの内容が不正です', [
      { field: 'after', message: 'カーソルの内容が想定と一致しません' },
    ]);
  }
  return result.data;
};
