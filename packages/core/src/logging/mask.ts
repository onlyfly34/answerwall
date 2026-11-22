import { BRAND } from '../brand.ts';
import type { LogFields } from '../contracts/index.ts';

export const REDACTED = '[redacted]';

/** Field names whose values are secrets whatever they look like. */
const SECRET_FIELD =
  /authorization|cookie|token|secret|passw(or)?d|passphrase|api[-_]?key|private[-_]?key|credential/i;
const PAIRING_CODE_FIELD = /pair(ing)?[-_]?code/i;

const MAX_DEPTH = 6;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Patterns that give a secret away inside free text. Order matters: the
 * specific shapes run before the catch-all for long opaque strings.
 */
const TEXT_RULES: readonly (readonly [RegExp, string])[] = [
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`],
  // The session cookie as it appears in Cookie and Set-Cookie headers.
  [new RegExp(`\\b(${escapeRegExp(BRAND.sessionCookie)})=[^\\s;,"']+`, 'g'), `$1=${REDACTED}`],
  // `token=…`, `api_key: …`, `"password":"…"` and similar pairs.
  [
    /\b((?:[a-z]+[-_])*(?:token|secret|passw(?:or)?d|passphrase|api[-_]?key)s?)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi,
    `$1$2${REDACTED}`,
  ],
  // API keys in the common `sk-…` shape.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Device tokens (base64url), hashes and other long opaque strings. UUIDs (36 characters) pass.
  [/[A-Za-z0-9_+=-]{40,}/g, REDACTED],
  // Pairing codes as they travel on the wire: eight digits standing alone.
  [/(?<![\d.])\d{8}(?![\d.])/g, REDACTED],
];

/** Masks credentials that appear inside a message or a string field. */
export function maskText(text: string): string {
  return TEXT_RULES.reduce((masked, [pattern, replacement]) => {
    return masked.replace(pattern, replacement);
  }, text);
}

function maskSecretField(name: string, value: unknown): unknown {
  // Flags and counts (`hasApiKey: true`, `outputTokens: 12`) carry no secret.
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number' && !PAIRING_CODE_FIELD.test(name)) return value;
  return REDACTED;
}

function maskValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'string') return maskText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  try {
    if (value instanceof Error) {
      return { name: value.name, message: maskText(value.message) };
    }
    if (value instanceof Date) return value.toISOString();
    if (ArrayBuffer.isView(value)) return '[binary]';
    if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1, seen));
    if (value instanceof Headers || value instanceof Map) {
      const entries: LogFields = Object.fromEntries(value.entries());
      return maskRecord(entries, depth + 1, seen);
    }
    return maskRecord(value as LogFields, depth + 1, seen);
  } finally {
    seen.delete(value);
  }
}

function maskRecord(record: LogFields, depth: number, seen: Set<object>): LogFields {
  const masked: LogFields = {};
  for (const [name, value] of Object.entries(record)) {
    masked[name] =
      SECRET_FIELD.test(name) || PAIRING_CODE_FIELD.test(name)
        ? maskSecretField(name, value)
        : maskValue(value, depth, seen);
  }
  return masked;
}

/**
 * A copy of `fields` that is safe to write: values of secret-looking field
 * names are replaced, and every string is scanned for credentials.
 */
export function maskFields(fields: LogFields): LogFields {
  return maskRecord(fields, 0, new Set());
}
