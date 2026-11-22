import { describe, expect, test } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { containsPattern, searchSpellings } from './search.ts';

describe('searchSpellings', () => {
  test('ASCII needs one spelling: LIKE already ignores its case', () => {
    expect(searchSpellings('Hello World')).toEqual(['Hello World']);
  });

  test('text without case needs one spelling', () => {
    expect(searchSpellings('天氣')).toEqual(['天氣']);
  });

  test('other alphabets get lower, upper and capitalised spellings', () => {
    expect(searchSpellings('привет')).toEqual(['привет', 'ПРИВЕТ', 'Привет']);
    expect(searchSpellings('ПРИвет')).toEqual(['ПРИвет', 'привет', 'ПРИВЕТ', 'Привет']);
  });

  test('spellings that differ only in ASCII case are searched once', () => {
    expect(searchSpellings('éCOLE')).toEqual(['éCOLE', 'ÉCOLE']);
  });

  test('capitalising keeps a first character outside the basic plane whole', () => {
    expect(searchSpellings('𐐨д')).toEqual(['𐐨д', '𐐀Д', '𐐀д']);
  });

  test('the empty string is its only spelling', () => {
    expect(searchSpellings('')).toEqual(['']);
  });
});

describe('containsPattern', () => {
  test('wraps the text in wildcards and escapes the ones inside', () => {
    expect(containsPattern('plain')).toBe('%plain%');
    expect(containsPattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('cursor', () => {
  test('decoding returns what was encoded', () => {
    const position = { createdAt: Date.UTC(2026, 5, 1, 12), ord: 123_456 };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(decodeCursor(encodeCursor({ createdAt: 0, ord: 0 }))).toEqual({ createdAt: 0, ord: 0 });
  });

  test('the largest safe values round-trip', () => {
    const position = { createdAt: Number.MAX_SAFE_INTEGER, ord: Number.MAX_SAFE_INTEGER };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  test.each(['', 'abc', 'a.b.c', 'A.B', '1 .2', 'zzzzzzzzzzz.1', '1.-2'])(
    '%j is not a cursor',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(/cursor/);
    },
  );
});
