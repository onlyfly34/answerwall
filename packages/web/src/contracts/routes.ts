/**
 * Client-side paths. The shell registers them with the router; everything
 * else links and navigates through these constants.
 */
export const ROUTES = {
  wall: '/',
  history: '/history',
  providers: '/providers',
  settings: '/settings',
  signIn: '/sign-in',
} as const;

let inFragment = false;

/**
 * Called once by the entry of a page that is a single file (the extension's
 * wall page): its client-side paths live in the address's fragment, so a
 * plain link must point there too.
 */
export function keepRoutesInFragment(enabled = true): void {
  inFragment = enabled;
}

/** The `href` of a plain link to a client-side path (a route, with or without a query). */
export function hrefOf(path: string): string {
  return inFragment ? `#${path}` : path;
}
