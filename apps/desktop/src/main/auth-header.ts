/**
 * The launch token's only way to the local server: the main process adds it
 * to the requests of the local window's session, and only to requests for
 * the exact origin the local server listens on.
 */

/** The local server of this launch and the token it accepts. */
export interface LocalGrant {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  token: string;
}

const isAuthorization = (name: string): boolean => name.toLowerCase() === 'authorization';

/**
 * The headers to send for a request to `url`. For the granted origin the
 * token replaces whatever `Authorization` the page set. For every other URL
 * the headers are returned as they came, minus this token should it ever
 * appear there (a redirect that carried the header along).
 */
export function authorizedHeaders(
  url: string,
  headers: Readonly<Record<string, string>>,
  grant: LocalGrant,
): Record<string, string> {
  const bearer = `Bearer ${grant.token}`;
  let origin: string | undefined;
  try {
    const target = new URL(url);
    origin = target.protocol === 'http:' ? target.origin : undefined;
  } catch {
    origin = undefined;
  }

  const result: Record<string, string> = {};
  const granted = origin !== undefined && origin === grant.origin;
  for (const [name, value] of Object.entries(headers)) {
    if (isAuthorization(name) && (granted || value === bearer)) continue;
    result[name] = value;
  }
  if (granted) result['Authorization'] = bearer;
  return result;
}
