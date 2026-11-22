import { describe, expect, test } from 'vitest';
import { createLineSplitter } from './line-splitter.ts';

const texts = (lines: { text: string }[]): string[] => lines.map((line) => line.text);

describe('createLineSplitter', () => {
  test('returns complete lines and keeps the unterminated rest for later', () => {
    const splitter = createLineSplitter(100);

    expect(texts(splitter.push(Buffer.from('one\ntwo\nthr')))).toEqual(['one', 'two']);
    expect(texts(splitter.push(Buffer.from('ee\n')))).toEqual(['three']);
    expect(splitter.flush()).toEqual([]);
  });

  test('flushes the last line when the stream ends without a newline', () => {
    const splitter = createLineSplitter(100);
    splitter.push(Buffer.from('first\nlast'));

    expect(splitter.flush()).toEqual([{ text: 'last', truncated: false }]);
  });

  test('strips the carriage return of CRLF line endings, also when it is split from its newline', () => {
    const splitter = createLineSplitter(100);

    expect(texts(splitter.push(Buffer.from('a\r\nb\r')))).toEqual(['a']);
    expect(texts(splitter.push(Buffer.from('\nc\r\n')))).toEqual(['b', 'c']);
  });

  test('keeps empty lines', () => {
    const splitter = createLineSplitter(100);

    expect(texts(splitter.push(Buffer.from('a\n\n\r\nb\n')))).toEqual(['a', '', '', 'b']);
  });

  test('reassembles a multi-byte character split across chunks', () => {
    const splitter = createLineSplitter(100);
    const bytes = Buffer.from('問題 ✓ 🙂\n', 'utf8');
    const lines = [];
    for (const byte of bytes) lines.push(...splitter.push(Buffer.from([byte])));

    expect(texts(lines)).toEqual(['問題 ✓ 🙂']);
  });

  test('cuts a line longer than the cap, flags it and recovers on the next line', () => {
    const splitter = createLineSplitter(8);
    const lines = [
      ...splitter.push(Buffer.from('0123456789')),
      ...splitter.push(Buffer.from('abcdefghij\nshort\n')),
    ];

    expect(lines).toEqual([
      { text: '01234567', truncated: true },
      { text: 'short', truncated: false },
    ]);
  });

  test('never buffers more than the cap, however much arrives without a newline', () => {
    const splitter = createLineSplitter(16);
    for (let i = 0; i < 1000; i++) splitter.push(Buffer.alloc(1024, 'x'));

    expect(splitter.flush()).toEqual([{ text: 'x'.repeat(16), truncated: true }]);
  });

  test('a line of exactly the cap is not truncated', () => {
    const splitter = createLineSplitter(4);

    expect(splitter.push(Buffer.from('abcd\n'))).toEqual([{ text: 'abcd', truncated: false }]);
  });
});
