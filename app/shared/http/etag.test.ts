import { describe, it, expect } from 'vitest';
import { formatETag, parseIfMatch } from './etag';
import { ValidationError } from '@/shared/domain/errors';

describe('formatETag', () => {
  it('version を weak ETag 形式 W/"<n>" にする', () => {
    expect(formatETag(7)).toBe('W/"7"');
    expect(formatETag(1)).toBe('W/"1"');
  });
});

describe('parseIfMatch', () => {
  it('weak ETag W/"7" から version 7 を取り出す', () => {
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it('strong ETag "7" から version 7 を取り出す', () => {
    expect(parseIfMatch('"7"')).toBe(7);
  });

  it('前後に空白があってもトリムして解釈する', () => {
    expect(parseIfMatch('  W/"42"  ')).toBe(42);
  });

  it('formatETag の出力をラウンドトリップできる', () => {
    expect(parseIfMatch(formatETag(123))).toBe(123);
  });

  it('クォートなしの裸の数字は不正として 400 を投げる', () => {
    expect(() => parseIfMatch('7')).toThrow(ValidationError);
  });

  it('数字でない中身は 400 を投げる', () => {
    expect(() => parseIfMatch('W/"abc"')).toThrow(ValidationError);
  });

  it('ワイルドカード * は（版指定でないため）400 を投げる', () => {
    // If-Match: * は「存在すれば何でも」を意味するが、本 API は版照合が目的なので
    // 受け付けない（無条件上書きを許すと楽観ロックの意味が無くなる）。
    expect(() => parseIfMatch('*')).toThrow(ValidationError);
  });

  it('空文字は 400 を投げる', () => {
    expect(() => parseIfMatch('')).toThrow(ValidationError);
  });

  it('負の数や小数は 400 を投げる', () => {
    expect(() => parseIfMatch('W/"-1"')).toThrow(ValidationError);
    expect(() => parseIfMatch('W/"1.5"')).toThrow(ValidationError);
  });
});
