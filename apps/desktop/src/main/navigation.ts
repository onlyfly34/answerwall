/**
 * Where a window may go. Every window is confined to the one place it was
 * opened for; links that lead elsewhere open in the system browser when they
 * are plain web links and are dropped otherwise.
 */

/** A web origin (local server, remote server) or one bundled file (the connection page). */
export type Confinement = { kind: 'origin'; origin: string } | { kind: 'file'; url: string };

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Whether `url` is an http(s) URL of exactly this origin (scheme, host and port). */
export function isSameOrigin(url: string, origin: string): boolean {
  const target = parse(url);
  if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) return false;
  return target.origin === origin;
}

/** Whether a navigation of any frame of the window may proceed. */
export function allowsNavigation(target: string, confinement: Confinement): boolean {
  if (confinement.kind === 'origin') return isSameOrigin(target, confinement.origin);
  const url = parse(target);
  const home = parse(confinement.url);
  if (!url || !home || url.protocol !== 'file:') return false;
  // The page may move within itself (a fragment), nowhere else.
  return url.pathname === home.pathname && url.search === home.search;
}

/**
 * What to do with a request for a new window (`target="_blank"`,
 * `window.open`). A new window is never opened in the app. `external`: hand
 * the URL to the system browser.
 */
export function windowOpenAction(target: string, confinement: Confinement): 'external' | 'drop' {
  const url = parse(target);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return 'drop';
  if (url.username !== '' || url.password !== '') return 'drop';
  // The app's own pages work only inside its window (the launch token, the paired session).
  if (confinement.kind === 'origin' && url.origin === confinement.origin) return 'drop';
  return 'external';
}

/**
 * Whether a request made by the local window's session may leave. The local
 * page talks to its own server and to nothing else; requests that are not
 * network requests (`data:`, `blob:`, developer tools) are not this rule's
 * business.
 */
export function allowsLocalRequest(url: string, origin: string): boolean {
  const target = parse(url);
  if (!target) return false;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) return true;
  return target.origin === origin;
}
