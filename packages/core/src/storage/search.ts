const LIKE_ESCAPE = '\\';

/**
 * Spellings of `query` to look for. SQLite's `LIKE` ignores case for ASCII
 * letters only, so for other alphabets the common casings are searched too.
 * Text without case (CJK) and plain ASCII yield a single spelling.
 */
export function searchSpellings(query: string): string[] {
  const lower = query.toLowerCase();
  const upper = query.toUpperCase();
  const [first = ''] = lower;
  const capitalised = first.toUpperCase() + lower.slice(first.length);
  const seen = new Set<string>();
  return [query, lower, upper, capitalised].filter((spelling) => {
    // Spellings that differ only in ASCII case match the same rows.
    const key = spelling.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A `LIKE ... ESCAPE '\'` pattern that matches `text` anywhere, literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (special) => LIKE_ESCAPE + special)}%`;
}
