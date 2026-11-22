/**
 * Turns the rendered answer of a site back into Markdown, so that the stored
 * answer reads like the others on the wall: headings, lists, code blocks,
 * tables, quotes, links and emphasis. Anything it does not know is read as
 * its text. The result is only ever stored and rendered through the wall's
 * own sanitising Markdown path; nothing here produces HTML.
 */

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'UL',
]);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',').toLowerCase();
const NEVER_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SVG']);
const ELEMENT = 1;
const TEXT = 3;

interface Context {
  strip: readonly string[];
}

function skipped(element: Element, context: Context): boolean {
  if (NEVER_TEXT.has(element.tagName.toUpperCase())) return true;
  if (element.hasAttribute('hidden')) return true;
  return context.strip.some((selector) => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  });
}

/** A block of its own: a block tag, or an unknown element (a custom element) that holds blocks. */
function isBlock(element: Element): boolean {
  return BLOCK_TAGS.has(element.tagName) || element.querySelector(BLOCK_SELECTOR) !== null;
}

/** The TeX source KaTeX and MathJax keep next to what they draw. */
function texOf(element: Element): string | undefined {
  const source = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  return source?.trim() || undefined;
}

function fence(text: string, language: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${text.replace(/\n+$/, '')}\n${marks}`;
}

function codeBlock(pre: Element): string {
  const code = pre.querySelector('code') ?? pre;
  const language = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(code.className)?.[1] ?? '';
  return fence(code.textContent ?? '', language);
}

function inlineCode(text: string): string {
  if (text === '') return '';
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const marks = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${marks}${pad}${text}${pad}${marks}`;
}

/** Wraps the text in emphasis marks, keeping the spaces around it outside of them. */
function wrap(inner: string, mark: string): string {
  const text = inner.trim();
  if (text === '') return inner;
  const lead = /^\s*/.exec(inner)?.[0] ?? '';
  const trail = /\s*$/.exec(inner)?.[0] ?? '';
  return `${lead}${mark}${text}${mark}${trail}`;
}

function inlineOf(node: Node, context: Context): string {
  if (node.nodeType === TEXT) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (node.nodeType !== ELEMENT) return '';
  const element = node as Element;
  if (skipped(element, context)) return '';
  if (element.classList.contains('katex') || element.tagName === 'MJX-CONTAINER') {
    const tex = texOf(element);
    if (tex !== undefined) return `$${tex}$`;
  }
  switch (element.tagName) {
    case 'BR':
      return '\n';
    case 'CODE':
    case 'KBD':
    case 'SAMP':
      return inlineCode(element.textContent ?? '');
    case 'STRONG':
    case 'B':
      return wrap(inlineChildren(element, context), '**');
    case 'EM':
    case 'I':
      return wrap(inlineChildren(element, context), '*');
    case 'DEL':
    case 'S':
      return wrap(inlineChildren(element, context), '~~');
    case 'IMG':
      return element.getAttribute('alt') ?? '';
    case 'A': {
      const text = inlineChildren(element, context);
      const href = element.getAttribute('href') ?? '';
      return /^https?:\/\//i.test(href) && text.trim() !== ''
        ? `[${text.trim().replace(/[[\]]/g, '\\$&')}](${href.replace(/[()\s]/g, encodeURIComponent)})`
        : text;
    }
    default:
      return inlineChildren(element, context);
  }
}

function inlineChildren(element: Element, context: Context): string {
  let text = '';
  for (const child of Array.from(element.childNodes)) text += inlineOf(child, context);
  return text;
}

const tidy = (text: string): string => text.replace(/[ \t]*\n[ \t]*/g, '\n').trim();

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : by + line))
    .join('\n');
}

function list(element: Element, context: Context): string {
  const ordered = element.tagName === 'OL';
  const start = Number.parseInt(element.getAttribute('start') ?? '1', 10) || 1;
  const items: string[] = [];
  let index = 0;
  for (const child of Array.from(element.children)) {
    if (child.tagName !== 'LI' || skipped(child, context)) continue;
    const marker = ordered ? `${start + index}. ` : '- ';
    index += 1;
    const parts = blocksOf(child, context);
    // A nested list follows its item directly; other blocks get a blank line.
    let body = parts[0] ?? '';
    for (const part of parts.slice(1)) body += (/^(- |\d+\. )/.test(part) ? '\n' : '\n\n') + part;
    items.push(marker + indent(body, ' '.repeat(marker.length)));
  }
  return items.join('\n');
}

function table(element: Element, context: Context): string {
  const rows = Array.from(element.querySelectorAll('tr')).map((row) =>
    Array.from(row.children)
      .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
      .map((cell) => tidy(inlineChildren(cell, context)).replace(/\n/g, ' ').replace(/\|/g, '\\|')),
  );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return '';
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, column) => cells[column] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array.from({ length: width }, () => '---')), ...body.map(line)].join(
    '\n',
  );
}

function blockOf(element: Element, context: Context): string[] {
  const tag = element.tagName;
  const heading = /^H([1-6])$/.exec(tag);
  if (heading) {
    const text = tidy(inlineChildren(element, context)).replace(/\n/g, ' ');
    return text === '' ? [] : [`${'#'.repeat(Number(heading[1]))} ${text}`];
  }
  switch (tag) {
    case 'PRE':
      return [codeBlock(element)];
    case 'UL':
    case 'OL':
      return [list(element, context)];
    case 'TABLE':
      return [table(element, context)];
    case 'HR':
      return ['---'];
    case 'BLOCKQUOTE':
      return [
        blocksOf(element, context)
          .join('\n\n')
          .split('\n')
          .map((line) => (line === '' ? '>' : `> ${line}`))
          .join('\n'),
      ];
    default:
      return blocksOf(element, context);
  }
}

/** The blocks an element's children make: block children as they are, runs of inline content as paragraphs. */
function blocksOf(element: Element, context: Context): string[] {
  const blocks: string[] = [];
  let run = '';
  const flush = (): void => {
    const text = tidy(run);
    if (text !== '') blocks.push(text);
    run = '';
  };
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === ELEMENT) {
      const childElement = child as Element;
      if (skipped(childElement, context)) continue;
      if (childElement.classList.contains('katex-display')) {
        const tex = texOf(childElement);
        if (tex !== undefined) {
          flush();
          blocks.push(`$$\n${tex}\n$$`);
          continue;
        }
      }
      if (isBlock(childElement)) {
        flush();
        blocks.push(...blockOf(childElement, context).filter((block) => block !== ''));
        continue;
      }
    }
    run += inlineOf(child, context);
  }
  flush();
  return blocks;
}

/**
 * The Markdown of what `root` shows. `strip` lists elements inside it that
 * are not part of the answer (copy buttons, toolbars).
 */
export function toMarkdown(root: Element, strip: readonly string[] = []): string {
  const context: Context = { strip };
  const blocks =
    BLOCK_TAGS.has(root.tagName) && !['DIV', 'SECTION', 'ARTICLE'].includes(root.tagName)
      ? blockOf(root, context)
      : blocksOf(root, context);
  return blocks.join('\n\n').trim();
}
