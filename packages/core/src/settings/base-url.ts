/**
 * Rules for the address of an OpenAI-compatible endpoint as it is stored.
 * The address lives in the settings document and is returned by the API, so
 * it must not carry anything secret; the API key has its own write-only field.
 */

function parse(baseUrl: string): URL | undefined {
  try {
    return new URL(baseUrl.trim());
  } catch {
    return undefined;
  }
}

/**
 * Why this address may not be stored, or `undefined` when it may. User info,
 * a query string and a fragment are where credentials get pasted, and none of
 * them is ever sent to the endpoint.
 */
export function baseUrlIssue(baseUrl: string): string | undefined {
  const url = parse(baseUrl);
  if (!url) return undefined;
  if (url.username === '' && url.password === '' && url.search === '' && url.hash === '') {
    return undefined;
  }
  return 'the address must not contain a user name, password, query string or fragment; put the credential in the API key field';
}

/** The address without user info, query string and fragment; unchanged when it has none. */
export function withoutCredentials(baseUrl: string): string {
  const url = parse(baseUrl);
  if (!url || baseUrlIssue(baseUrl) === undefined) return baseUrl;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Whether both addresses name the same scheme, host and port. A stored API
 * key belongs to the origin it was entered for. An address that cannot be
 * read has no origin and equals nothing.
 */
export function sameOrigin(a: string, b: string): boolean {
  const first = parse(a)?.origin;
  return first !== undefined && first !== 'null' && first === parse(b)?.origin;
}
