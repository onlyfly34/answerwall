import { describe, expect, test } from 'vitest';
import { renderMarkdown } from './render.ts';

function render(text: string): HTMLDivElement {
  const host = document.createElement('div');
  host.append(renderMarkdown(text));
  return host;
}

/** Elements and attributes through which a document can load something or run script. */
const ACTIVE_ELEMENTS =
  'img, picture, source, video, audio, track, iframe, frame, object, embed, script, style, link, meta, base, form, input, button, svg, math, use, image, foreignObject, textarea, select, details, dialog, template, noscript, applet, body, html, head';
const LOADING_ATTRIBUTES = [
  'src',
  'srcset',
  'srcdoc',
  'style',
  'background',
  'poster',
  'data',
  'action',
  'formaction',
  'xlink:href',
  'ping',
  'id',
  'name',
];

function expectInert(host: HTMLElement): void {
  expect(host.querySelector(ACTIVE_ELEMENTS)).toBeNull();
  for (const element of Array.from(host.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false);
      expect(LOADING_ATTRIBUTES, `${element.tagName} ${attribute.name}`).not.toContain(
        attribute.name,
      );
    }
    if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) {
      expect(element.getAttribute('href')).toMatch(/^(https?:\/\/|mailto:)/i);
      expect(element.target).toBe('_blank');
      expect(element.rel).toBe('noopener noreferrer');
    } else {
      expect(element.hasAttribute('href')).toBe(false);
    }
  }
}

describe('ordinary Markdown', () => {
  test('renders headings, emphasis, lists, tables and code', () => {
    const host = render(
      [
        '# Title',
        '',
        'Some **bold** and *soft* text with `code`.',
        '',
        '- one',
        '- two',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '```ts',
        'const x = 1 < 2;',
        '```',
      ].join('\n'),
    );
    expect(host.querySelector('h1')?.textContent).toBe('Title');
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.querySelectorAll('td')).toHaveLength(2);
    expect(host.querySelector('pre code')?.textContent).toBe('const x = 1 < 2;\n');
    expect(host.querySelector('pre code')?.className).toBe('language-ts');
  });

  test('links open in a new context without an opener or referrer', () => {
    const link = render('[site](https://example.com/a?b=1 "tip")').querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.title).toBe('tip');
  });

  test('a bare address and a mail address become links', () => {
    const host = render('See https://example.com/x and <mailto:someone@example.com>.');
    expect(Array.from(host.querySelectorAll('a'), (a) => a.getAttribute('href'))).toEqual([
      'https://example.com/x',
      'mailto:someone@example.com',
    ]);
    expectInert(host);
  });

  test('task list boxes are text, not inputs', () => {
    const host = render('- [x] done\n- [ ] open');
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('☑');
    expect(host.textContent).toContain('☐');
  });
});

describe('images are never loaded', () => {
  test('a Markdown image becomes a link to its address', () => {
    const host = render('![a chart](https://tracker.example/pixel.png "Chart")');
    expectInert(host);
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://tracker.example/pixel.png');
    expect(link?.textContent).toBe('a chart');
  });

  test('an image without a description shows its address', () => {
    const link = render('![](http://tracker.example/p.gif)').querySelector('a');
    expect(link?.textContent).toBe('http://tracker.example/p.gif');
  });

  test('a data: image leaves only its description', () => {
    const host = render('![inline](data:image/png;base64,AAAA)');
    expectInert(host);
    expect(host.textContent).toContain('inline');
  });

  test('a reference-style image is a link too', () => {
    const host = render('![logo][l]\n\n[l]: https://tracker.example/logo.svg');
    expectInert(host);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://tracker.example/logo.svg');
  });
});

describe('hostile content is inert', () => {
  const hostile: Record<string, string> = {
    'an image tag': '<img src=http://tracker.example/x.png>',
    'an image with an error handler': '<img src=x onerror=alert(1)>',
    'a script block': '<script>fetch("http://tracker.example/")</script>',
    'a script inside a paragraph':
      'hello <script src="http://tracker.example/x.js"></script> there',
    'a javascript: link': '[click](javascript:alert(1))',
    'a javascript: link with entities': '[click](&#106;avascript:alert(1))',
    'a javascript: link with whitespace': '[click](java\tscript:alert(1))',
    'a javascript: autolink': '<javascript:alert(1)>',
    'a vbscript: link': '[click](vbscript:msgbox(1))',
    'a data: HTML link': '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    'a data: HTML link in raw HTML': '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    'an inline event handler': '<div onclick="alert(1)" onmouseover="alert(2)">text</div>',
    'an SVG with onload': '<svg onload="alert(1)"><circle r="1"/></svg>',
    'an SVG script': '<svg><script>alert(1)</script></svg>',
    'an SVG external reference': '<svg><use href="http://tracker.example/s.svg#a"/></svg>',
    'an SVG image': '<svg><image href="http://tracker.example/i.png"/></svg>',
    'an SVG animate payload':
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
    'a foreignObject payload':
      '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
    'a MathML payload': '<math><mtext><img src=http://tracker.example/m></mtext></math>',
    'an iframe': '<iframe src="http://tracker.example/"></iframe>',
    'an iframe with srcdoc': '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    'an object and an embed':
      '<object data="http://tracker.example/o"></object><embed src="http://tracker.example/e">',
    'a style block': '<style>body{background:url(http://tracker.example/bg)}</style>',
    'a style attribute': '<p style="background:url(http://tracker.example/bg)">x</p>',
    'a stylesheet link': '<link rel="stylesheet" href="http://tracker.example/s.css">',
    'a meta refresh': '<meta http-equiv="refresh" content="0;url=http://tracker.example/">',
    'a base tag': '<base href="http://tracker.example/">',
    'a form': '<form action="http://tracker.example/"><input name="q"><button>go</button></form>',
    'a video with a poster':
      '<video poster="http://tracker.example/p.png" src="http://tracker.example/v"></video>',
    'an audio source': '<audio><source src="http://tracker.example/a.mp3"></audio>',
    'a link with a ping': '<a href="https://example.com" ping="http://tracker.example/ping">x</a>',
    'a relative link into the application': '[sign out](/api/auth/logout)',
    'a protocol-relative link': '[x](//tracker.example/x)',
    'an image inside a link': '[![x](http://tracker.example/i.png)](http://tracker.example/)',
    'an image in a table': '| a |\n|---|\n| <img src=http://tracker.example/t.png> |',
    'an image in a list': '- item <img src="http://tracker.example/l.png">',
    'an image in a blockquote':
      '> quote ![q](http://tracker.example/q.png) <img src=http://tracker.example/q2.png>',
    'an image in a heading': '# <img src=http://tracker.example/h.png>',
    'markup in a code fence info string': '```"><img src=http://tracker.example/c.png>\ncode\n```',
    'markup in a link title':
      '[x](https://example.com "\\"><img src=http://tracker.example/t.png>")',
    'a mutation payload': '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    'a comment payload':
      '<!--<img src=http://tracker.example/c.png>--><!--><script>alert(1)</script>-->',
    'a clobbering id': '<a id="location" name="location" href="https://example.com">x</a>',
    'an unclosed tag while streaming': 'text <img src="http://tracker.example/partial',
  };

  for (const [name, source] of Object.entries(hostile)) {
    test(name, () => {
      expectInert(render(source));
    });
  }

  test('raw HTML is shown as the text the provider wrote', () => {
    const host = render('<script>alert(1)</script>');
    expect(host.textContent).toContain('<script>alert(1)</script>');
  });

  test('every prefix of a hostile answer is inert, as it would be while streaming', () => {
    const source =
      'Intro <img src=http://tracker.example/a.png onerror=alert(1)> and [x](javascript:alert(1))\n\n<svg onload=alert(1)>\n\n![p](http://tracker.example/b.png)';
    for (let length = 1; length <= source.length; length += 1) {
      expectInert(render(source.slice(0, length)));
    }
  });

  test('all hostile samples together stay inert once attached to the document', () => {
    const host = render(Object.values(hostile).join('\n\n'));
    document.body.append(host);
    try {
      expectInert(host);
    } finally {
      host.remove();
    }
  });
});
