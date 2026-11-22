import { StringDecoder } from 'node:string_decoder';

export interface SplitLine {
  text: string;
  /** The line was longer than the cap; `text` holds only its beginning. */
  truncated: boolean;
}

export interface LineSplitter {
  /** Feeds a chunk and returns the lines it completed. */
  push(chunk: Buffer): SplitLine[];
  /** Returns the unterminated last line, if any. Call once, at end of stream. */
  flush(): SplitLine[];
}

/**
 * Splits a byte stream into lines. Handles lines and multi-byte characters
 * split across chunks, and `\r\n`. Memory is bounded: a line longer than
 * `maxLineLength` characters is cut there and the rest of it is discarded.
 */
export function createLineSplitter(maxLineLength: number): LineSplitter {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let truncated = false;

  const append = (text: string): void => {
    const room = maxLineLength - pending.length;
    if (text.length > room) truncated = true;
    if (room > 0) pending += text.slice(0, room);
  };

  const take = (): SplitLine => {
    const line = { text: pending.endsWith('\r') ? pending.slice(0, -1) : pending, truncated };
    pending = '';
    truncated = false;
    return line;
  };

  const consume = (text: string): SplitLine[] => {
    const lines: SplitLine[] = [];
    let from = 0;
    for (;;) {
      const newline = text.indexOf('\n', from);
      if (newline === -1) break;
      append(text.slice(from, newline));
      lines.push(take());
      from = newline + 1;
    }
    append(text.slice(from));
    return lines;
  };

  return {
    push: (chunk) => consume(decoder.write(chunk)),
    flush() {
      const lines = consume(decoder.end());
      if (pending !== '' || truncated) lines.push(take());
      return lines;
    },
  };
}
