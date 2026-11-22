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
