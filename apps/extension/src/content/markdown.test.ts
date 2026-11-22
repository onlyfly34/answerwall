import { describe, expect, test } from 'vitest';
import { toMarkdown } from './markdown.ts';

function markdown(html: string, strip: string[] = []): string {
  const root = document.createElement('div');
  root.innerHTML = html;
  return toMarkdown(root, strip);
}

describe('a rendered answer back to Markdown', () => {
  test('paragraphs, emphasis, inline code and links', () => {
    expect(
      markdown(
        '<p>A <strong>bold</strong> and <em>soft</em> word, <code>x = 1</code>, a <a href="https://example.com/a b">link</a>.</p><p>Second<br>line.</p>',
      ),
    ).toBe(
      'A **bold** and *soft* word, `x = 1`, a [link](https://example.com/a%20b).\n\nSecond\nline.',
    );
  });

  test('headings and rules', () => {
    expect(markdown('<h2>Title</h2><p>Text</p><hr><h4>Small</h4>')).toBe(
      '## Title\n\nText\n\n---\n\n#### Small',
    );
  });

  test('a code block keeps its text and language, whatever surrounds the code element', () => {
    const html = `<pre><div class="header"><span>python</span><button>Copy</button></div><code class="hljs language-python">def f():\n    return 1\n\n\nprint(f())\n</code></pre>`;
    expect(markdown(html)).toBe('```python\ndef f():\n    return 1\n\n\nprint(f())\n```');
  });

  test('a code block that contains a fence gets a longer one', () => {
    expect(markdown('<pre><code>```\ninner\n```</code></pre>')).toBe('````\n```\ninner\n```\n````');
    expect(markdown('<p><code>a`b</code></p>')).toBe('``a`b``');
  });

  test('lists, ordered, nested and with a start', () => {
    expect(
      markdown(
        '<ul><li>One</li><li>Two<ul><li>Inner</li></ul></li></ul><ol start="3"><li><p>Three</p><p>More</p></li><li>Four</li></ol>',
      ),
    ).toBe('- One\n- Two\n  - Inner\n\n3. Three\n\n   More\n4. Four');
  });

  test('a table becomes a pipe table', () => {
    expect(
      markdown(
        '<table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td>a|b</td><td><code>1</code></td></tr></tbody></table>',
      ),
    ).toBe('| Name | Size |\n| --- | --- |\n| a\\|b | `1` |');
  });

  test('a quote', () => {
    expect(markdown('<blockquote><p>First</p><p>Second</p></blockquote>')).toBe(
      '> First\n>\n> Second',
    );
  });

  test('formulas are read from the TeX source the renderer keeps', () => {
    const katex = (tex: string) =>
      `<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">junk</span></span>`;
    expect(markdown(`<p>So ${katex('a^2')} holds.</p>`, ["[aria-hidden='true']"])).toBe(
      'So $a^2$ holds.',
    );
    expect(markdown(`<span class="katex-display">${katex('x = 1')}</span>`)).toBe('$$\nx = 1\n$$');
  });

  test('buttons, scripts, hidden parts and what the rule strips are left out', () => {
    expect(
      markdown(
        '<p>Kept<button>Copy</button><script>alert(1)</script><span hidden>secret</span><span class="toolbar">Edit</span></p>',
        ['.toolbar'],
      ),
    ).toBe('Kept');
  });

  test('custom elements and bare text are read through', () => {
    expect(
      markdown('<message-content><div class="markdown"><p>Inside</p></div></message-content>tail'),
    ).toBe('Inside\n\ntail');
  });

  test('nothing but text ever comes out: markup in the page is not copied', () => {
    const result = markdown(
      '<p>See <img src="http://tracker.example/i.png" alt="a chart"> and <a href="javascript:alert(1)">this</a></p>',
    );
    expect(result).toBe('See a chart and this');
    expect(result).not.toContain('<');
  });

  test('an invalid strip selector is ignored instead of breaking the read', () => {
    expect(markdown('<p>Text</p>', ['::bad(('])).toBe('Text');
  });
});
