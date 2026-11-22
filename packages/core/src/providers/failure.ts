import type { ProviderErrorCode } from '../protocol/index.ts';

export interface Failure {
  code: ProviderErrorCode;
  /** User-facing: sanitised, without paths, account identifiers or secrets. */
  message: string;
}

const MAX_MESSAGE_LENGTH = 300;

const PATTERNS: readonly (readonly [ProviderErrorCode, RegExp])[] = [
  [
    'model_not_found',
    /model_not_found|unknown model|invalid model|no such model|model\b[^\n]{0,80}\b(not found|does not exist|may not exist|not supported|is not available|not available|unavailable|unknown)/i,
  ],
  [
    'prompt_too_long',
    /prompt is too long|context[_ ](length|window)|maximum context|too many tokens|input is too long|string too long/i,
  ],
  [
    'quota',
    /(usage|session|weekly|spending) limit|quota|billing|credit|(?<!rate[ _-]?)limit reached|out of (extra )?usage|payment required/i,
  ],
  ['rate_limited', /rate[ _-]?limit|too many requests|\b429\b|overloaded/i],
  [
    'not_logged_in',
    /not logged in|logged out|please run \/login|log ?in required|sign in|authenticat|unauthori[sz]ed|invalid (api key|credentials|token)|token (has )?expired|\b401\b/i,
  ],
  [
    'network',
    /network|econn|enotfound|etimedout|eai_again|connection (refused|reset|error|closed)|stream disconnected|fetch failed|socket hang up|could not resolve/i,
  ],
];

/** Guesses why a provider failed from the text it printed. */
export function classifyFailureText(text: string): ProviderErrorCode | undefined {
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

// eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
/** `file://` URLs: the form stack traces of Node-based CLIs use. */
const FILE_URL = /\bfile:\/\/[^\s"'`<>)]+/gi;
/** A quoted absolute path is redacted up to its closing quote, spaces included. */
const QUOTED_PATH = /(["'`])(?:[A-Za-z]:[\\/]|\\\\|~?\/(?!\/))[^"'`\n]{0,400}\1/g;
/**
 * Unquoted paths. A directory name may hold up to two more space-separated
 * words ("Application Support"); the last component may not, so the sentence
 * after a path survives.
 */
const WIN_CHAR = '[^\\\\/\\s"\'`<>|:*?]';
const WIN_TAIL = `(?:${WIN_CHAR}+(?: ${WIN_CHAR}+){0,2}[\\\\/]+)*${WIN_CHAR}*`;
/** A drive letter followed by either separator. */
const WINDOWS_PATH = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]+${WIN_TAIL}`, 'g');
const UNC_PATH = new RegExp(`(?<![\\\\\\w])\\\\{2,}${WIN_CHAR}+[\\\\/]+${WIN_TAIL}`, 'g');
const POSIX_CHAR = '[\\p{L}\\p{N}_.@+%=~-]';
/** Not after `/` or a word character, so URLs and "and/or" are left alone. */
const POSIX_PATH = new RegExp(
  `(?<![\\p{L}\\p{N}_./\\\\<])~?/(?:${POSIX_CHAR}+(?: ${POSIX_CHAR}+){0,2}/)+${POSIX_CHAR}*`,
  'gu',
);
const SECRET = /\b(sk|pk|xai|key|gsk|AIza)[-_][\w-]{8,}|\b[A-Za-z0-9_-]{40,}\b/g;

/**
 * Makes provider output safe to show and store: no escape sequences, e-mail
 * addresses, absolute paths or key-like strings, one line, bounded length.
 */
export function sanitizeDiagnostic(text: string, maxLength = MAX_MESSAGE_LENGTH): string {
  const clean = text
    .replace(ANSI_SEQUENCE, '')
    .replace(EMAIL, '<email>')
    .replace(FILE_URL, '<path>')
    .replace(QUOTED_PATH, '$1<path>$1')
    .replace(WINDOWS_PATH, '<path>')
    .replace(UNC_PATH, '<path>')
    .replace(POSIX_PATH, '<path>')
    .replace(SECRET, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** A failure from what the provider said; `code` wins over guessing from the text. */
export function failureFromText(
  text: string,
  fallbackMessage: string,
  code?: ProviderErrorCode,
): Failure {
  return {
    code: code ?? classifyFailureText(text) ?? 'unknown',
    message: sanitizeDiagnostic(text) || fallbackMessage,
  };
}
