import { describe, expect, test } from 'vitest';
import css from './theme.css?raw';

/** The colour tokens of one theme; the dark ones live in the media query. */
function tokens(theme: 'light' | 'dark'): Record<string, string> {
  const [light = '', dark = ''] = css.split('@media (prefers-color-scheme: dark)');
  const found: Record<string, string> = {};
  for (const match of (theme === 'light' ? light : dark).matchAll(
    /--color-([\w-]+):\s*(#[0-9a-f]{6})/gi,
  )) {
    if (match[1] && match[2]) found[match[1]] = match[2];
  }
  return found;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('the colour tokens', () => {
  // Each of these is the colour of small text, on the page and on a surface
  // (cell headers, cards). The accent is not listed: it is text on the page only.
  const TEXT_TOKENS = ['text', 'text-muted', 'success', 'warning', 'danger'];

  test.each(['light', 'dark'] as const)(
    '%s: text colours reach WCAG AA on both backgrounds',
    (theme) => {
      const colours = tokens(theme);
      const pairs = TEXT_TOKENS.flatMap((name) => [
        [name, 'bg'],
        [name, 'surface'],
      ]);
      for (const [name = '', background = ''] of [...pairs, ['accent', 'bg']]) {
        const ratio = contrast(colours[name] ?? '', colours[background] ?? '');
        expect(ratio, `${theme} ${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
