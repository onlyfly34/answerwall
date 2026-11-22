import { Hono } from 'hono';
import { requireAuth } from './auth/index.ts';
import type { AppDeps, AppEnv } from './contracts/index.ts';
import { askRoutes } from './routes/ask.ts';
import { authRoutes } from './routes/auth.ts';
import { historyRoutes } from './routes/history.ts';
import { metaRoutes } from './routes/meta.ts';
import { presetRoutes } from './routes/presets.ts';
import { providerRoutes } from './routes/providers.ts';
import { settingsRoutes } from './routes/settings.ts';

/** The only API routes reachable without authentication, as `"<METHOD> <path>"`. */
export const PUBLIC_API_ROUTES: readonly string[] = [
  'GET /api/meta',
  'POST /api/auth/pair',
  'POST /api/auth/session',
];

/**
 * The composition root of the HTTP surface. The middleware order below is
 * part of the security design; change it only together with
 * docs/ARCHITECTURE.md.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { http } = deps;
  const app = new Hono<AppEnv>();
  app.onError(http.onError);
  app.notFound(http.notFound);

  app.use(http.requestLog, http.securityHeaders, http.clientInfo, http.peerGuard, http.hostGuard);
  app.use(
    '/api/*',
    http.originGuard,
    http.authRateLimit,
    http.bodyLimit,
    requireAuth(deps.auth, PUBLIC_API_ROUTES),
  );

  app.route('/api/meta', metaRoutes(deps));
  app.route('/api/auth', authRoutes(deps));
  app.route('/api/providers', providerRoutes(deps));
  app.route('/api/ask', askRoutes(deps));
  app.route('/api/presets', presetRoutes(deps));
  app.route('/api/history', historyRoutes(deps));
  app.route('/api/settings', settingsRoutes(deps));
  // Unknown API paths must not fall through to the UI's index.html fallback.
  app.all('/api/*', http.notFound);

  if (http.staticUi) app.use(http.staticUi);
  return app;
}
