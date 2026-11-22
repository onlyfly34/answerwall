import { describe, expect, test } from 'vitest';
import { COPY_CODE_ATTRIBUTE, createIncrementalMarkdown } from './incremental.ts';
import { renderMarkdown } from './render.ts';

function setup() {
  const container = document.createElement('div');
  const markdown = createIncrementalMarkdown(container, () => ({ copy: 'Copy' }));
  return { container, markdown };
}

/** What a one-off render of the same text gives, with the code-block chrome removed. */
function plain(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const header of Array.from(clone.querySelectorAll('.wall-code-header'))) header.remove();
  for (const wrapper of Array.from(clone.querySelectorAll('.wall-code'))) {
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  return clone.innerHTML;
}

function reference(text: string): string {
  const host = document.createElement('div');
  host.append(renderMarkdown(text));
  return host.innerHTML;
}

const ANSWER = [
  '# Monads',
  '',
  'A monad is a **monoid** in the category of endofunctors, see [the docs][d].',
  '',
  '1. unit',
  '2. bind',
  '',
  '```hs',
  'return :: a -> m a',
  '(>>=) :: m a -> (a -> m b) -> m b',
  '```',
  '',
  '| law | meaning |',
  '|---|---|',
  '| left identity | `return a >>= f` is `f a` |',
  '',
  '> Remember <img src=http://tracker.example/x.png> the laws.',
  '',
  'Setext heading',
  '===',
  '',
  '[d]: https://example.com/docs',
  '',
  'Done.',
].join('\n');

describe('incremental Markdown', () => {
  test('streaming a text in small pieces ends with the same DOM as rendering it once', () => {
    const { container, markdown } = setup();
    for (let length = 1; length <= ANSWER.length; length += 3) {
      const prefix = ANSWER.slice(0, length);
      markdown.update(prefix);
      expect(plain(container), `after ${length} characters`).toBe(reference(prefix));
    }
    markdown.update(ANSWER);
    expect(plain(container)).toBe(reference(ANSWER));
    expect(container.querySelector('img')).toBeNull();
  });

  test('appending to the last paragraph re-renders that block only and keeps the others', () => {
    const { container, markdown } = setup();
    expect(markdown.update('First paragraph.\n\nSecond')).toBe(2);
    const first = container.firstElementChild;
    expect(markdown.update('First paragraph.\n\nSecond paragraph grows.')).toBe(1);
    expect(container.firstElementChild).toBe(first);
    expect(container.children).toHaveLength(2);
    expect(markdown.update('First paragraph.\n\nSecond paragraph grows.')).toBe(0);
  });

  test('a link definition that arrives or changes later re-renders the blocks before it', () => {
    const { container, markdown } = setup();
    markdown.update('See [the docs][d].\n\nMore text.');
    expect(container.querySelector('a')).toBeNull();
    markdown.update('See [the docs][d].\n\nMore text.\n\n[d]: https://example.com/a');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
    markdown.update('See [the docs][d].\n\nMore text.\n\n[d]: https://example.com/abc');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/abc');
  });

  test('a shorter or different text replaces what was rendered', () => {
    const { container, markdown } = setup();
    markdown.update('# One\n\nTwo\n\nThree');
    markdown.update('# Other');
    expect(container.children).toHaveLength(1);
    expect(container.textContent.trim()).toBe('Other');
    markdown.update('');
    expect(container.childNodes).toHaveLength(0);
  });

  test('code blocks get their language and a copy button', () => {
    const { container, markdown } = setup();
    markdown.update('```ts\nconst a = 1;\n```\n\n```\nplain\n```');
    const blocks = Array.from(container.querySelectorAll('.wall-code'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.querySelector('.wall-code-header span')?.textContent).toBe('ts');
    expect(blocks[1]?.querySelector('.wall-code-header span')?.textContent).toBe('');
    for (const block of blocks) {
      const button = block.querySelector('button');
      expect(button?.hasAttribute(COPY_CODE_ATTRIBUTE)).toBe(true);
      expect(button?.type).toBe('button');
      expect(button?.textContent).toBe('Copy');
    }
    expect(blocks[0]?.querySelector('pre')?.textContent).toBe('const a = 1;\n');
  });

  test('an unfinished code fence is a code block while it streams', () => {
    const { container, markdown } = setup();
    markdown.update('```js\nconsole.log(');
    expect(container.querySelector('.wall-code pre code')?.textContent).toBe('console.log(\n');
    markdown.update('```js\nconsole.log(1)\n```\n\nafter');
    expect(container.querySelectorAll('.wall-code')).toHaveLength(1);
    expect(container.lastElementChild?.textContent).toBe('after');
  });

  test('reset drops everything so the next update renders all blocks again', () => {
    const { container, markdown } = setup();
    markdown.update('a\n\nb');
    markdown.reset();
    expect(container.childNodes).toHaveLength(0);
    expect(markdown.update('a\n\nb')).toBe(2);
  });

  test('a 200 KB answer: each further delta re-renders one block, not the document', () => {
    const paragraph = `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8)}\n\n`;
    const code = '```ts\nexport const answer = 42;\n```\n\n';
    let text = '';
    while (text.length < 200 * 1024) text += paragraph + code;
    const { container, markdown } = setup();

    const blocks = markdown.update(text);
    expect(blocks).toBeGreaterThan(800);
    const before = Array.from(container.children);

    const started = performance.now();
    let rendered = 0;
    const deltas = 20;
    for (let delta = 0; delta < deltas; delta += 1) {
      text += ' more';
      rendered += markdown.update(text);
    }
    const perDelta = (performance.now() - started) / deltas;

    // The first delta opens a new paragraph; every later one replaces just that paragraph.
    expect(rendered).toBe(deltas);
    expect(Array.from(container.children).slice(0, before.length)).toEqual(before);
    // Generous: the scheduler also stretches its interval to four times the measured cost.
    expect(perDelta).toBeLessThan(250);
  });
});
