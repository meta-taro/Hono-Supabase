import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { encodeCursor, decodeCursor } from './cursor';
import { ValidationError } from '@/shared/domain/errors';

// カーソルは presentation 層の DTO（{ name, id }）を base64url 文字列に包んで
// クライアントに「不透明（opaque）」な 1 トークンとして渡すための汎用コーデック。
// クライアントは中身を知らなくてよい（next_cursor をそのまま付け直すだけ）。

const CursorSchema = z.object({
  name: z.string(),
  id: z.string().uuid(),
});

describe('cursor codec', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('日本語を含むペイロードをラウンドトリップできる', () => {
      // btoa/atob は Latin1 しか扱えないため、日本語（ケーキ名）が壊れないことを保証する。
      const payload = { name: 'ガトーショコラ', id: '11111111-1111-4111-8111-111111111111' };

      const encoded = encodeCursor(payload);
      const decoded = decodeCursor(encoded, CursorSchema);

      expect(decoded).toEqual(payload);
    });

    it('エンコード結果は URL セーフ（+ / = を含まない）', () => {
      // クエリ文字列（?after=...）にそのまま載せられるよう base64url を使う。
      const encoded = encodeCursor({
        name: 'チョコレート/ケーキ+苺=',
        id: '22222222-2222-4222-8222-222222222222',
      });

      expect(encoded).not.toMatch(/[+/=]/);
    });
  });

  describe('decodeCursor の異常系', () => {
    it('base64 として壊れた文字列は ValidationError を投げる', () => {
      expect(() => decodeCursor('!!!not-base64!!!', CursorSchema)).toThrow(ValidationError);
    });

    it('JSON ではない中身は ValidationError を投げる', () => {
      const encoded = encodeCursor('plain string, not the expected object');
      expect(() => decodeCursor(encoded, CursorSchema)).toThrow(ValidationError);
    });

    it('スキーマに合致しない中身（id が UUID でない）は ValidationError を投げる', () => {
      // 改竄カーソル対策: 中身を検証して想定外なら 400 に倒す。
      const tampered = encodeCursor({ name: 'X', id: 'not-a-uuid' });
      expect(() => decodeCursor(tampered, CursorSchema)).toThrow(ValidationError);
    });
  });
});
