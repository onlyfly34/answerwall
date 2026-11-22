/**
 * Markdown to DOM for answers, which are untrusted text.
 *
 * Two independent layers keep an answer from running script or reaching the
 * network: the renderer never emits an image and shows raw HTML as literal
 * text, and the sanitiser then keeps only an allowlist of tags, attributes
 * and absolute http(s)/mailto link targets.
 */
import createDOMPurify from 'dompurify';
import { Marked } from 'marked';
import type { Token, TokensList } from 'marked';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    /** Raw HTML in an answer is shown, not interpreted. */
    html: ({ text }) => escapeHtml(text),
    /** Images are never loaded: an image becomes a link to its address. */
    image: ({ href, title, text }) =>
      `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text || href)}</a>`,
    checkbox: ({ checked }) => (checked ? '☑ ' : '☐ '),
  },
});

const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];
const ALLOWED_ATTR = ['href', 'title', 'align', 'start', 'class'];
/** Absolute links only: a relative one would point into this application. */
const ALLOWED_URI = /^(?:https?:\/\/|mailto:)/i;

export const CODE_LANGUAGE_CLASS = /^language-(\S+)$/;

const purify = createDOMPurify(window);
purify.addHook('afterSanitizeAttributes', (node) => {
  // The only class an answer may carry is the language of a code block.
  const className = node.getAttribute('class');
  if (className !== null && !(node.nodeName === 'CODE' && CODE_LANGUAGE_CLASS.test(className))) {
    node.removeAttribute('class');
  }
  if (node.nodeName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitizeHtml(html: string): DocumentFragment {
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
}

/** One top-level block of a document. */
export interface MarkdownBlock {
  /** The source text of the block; equal sources render equally while `definitions` is unchanged. */
  raw: string;
  token: Token;
}

export interface MarkdownDocument {
  blocks: MarkdownBlock[];
  /** The link reference definitions, serialised; a change can alter how any block renders. */
  definitions: string;
}

export function lexMarkdown(text: string): MarkdownDocument {
  const tokens: TokensList = marked.lexer(text);
  return {
    blocks: tokens
      .filter((token) => token.type !== 'space' && token.type !== 'def')
      .map((token) => ({ raw: token.raw, token })),
    definitions: JSON.stringify(tokens.links),
  };
}

export function renderBlock(block: MarkdownBlock): DocumentFragment {
  return sanitizeHtml(marked.parser([block.token]));
}

/** Renders a whole document at once; the wall itself renders block by block. */
export function renderMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of lexMarkdown(text).blocks) fragment.append(renderBlock(block));
  return fragment;
}
