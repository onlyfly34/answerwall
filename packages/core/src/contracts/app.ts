import type { HttpBindings } from '@hono/node-server';
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import type { AuthContext, AuthService } from './auth.ts';
import type { AppConfig } from './config.ts';
import type { Clock, Logger } from './platform.ts';
import type { ProviderRegistry } from './providers.ts';
import type { AskManager } from './runner.ts';
import type { SettingsService } from './settings.ts';
import type { Storage } from './storage.ts';
import type { TlsProvider } from './tls.ts';

/** What the HTTP layer knows about the peer once proxy headers have been vetted. */
export interface ClientInfo {
  /** The client's IP address: the forwarded one when the socket peer is a trusted proxy. */
  address: string;
  /** The request arrived over TLS, or a trusted proxy says it did. Decides the `Secure` cookie flag. */
  secure: boolean;
}

export interface AppEnv {
  /** Absent when the app is driven without a socket (`app.request()` in tests). */
  Bindings: Partial<HttpBindings>;
  Variables: {
    /** Set by `HttpLayer.clientInfo` for every request. */
    client: ClientInfo;
    /** Set by the auth middleware for every route that is not public. */
    auth: AuthContext;
  };
}

export type AppMiddleware = MiddlewareHandler<AppEnv>;

/**
 * The cross-cutting HTTP pieces. The composition root applies them in the
 * order documented in `app.ts`; each one rejects by throwing an `AppError`.
 */
export interface HttpLayer {
  /** Logs method, path, status and duration; never headers, query strings or bodies. */
  requestLog: AppMiddleware;
  /** Sets `client`, honouring `X-Forwarded-*` only from trusted proxies. */
  clientInfo: AppMiddleware;
  /** With TLS off on a non-loopback bind, refuses peers that are neither loopback nor a trusted proxy. */
  peerGuard: AppMiddleware;
  /** Rejects requests whose `Host` is not in the allowlist. */
  hostGuard: AppMiddleware;
  /** CSP and the other fixed response headers; never any `Access-Control-*`. */
  securityHeaders: AppMiddleware;
  /** Non-GET requests: same-origin `Origin` and `Content-Type: application/json`. */
  originGuard: AppMiddleware;
  /** Blocks a client address that exceeded the failed-auth limit; counts 401 responses. */
  authRateLimit: AppMiddleware;
  /** Enforces the configured request body limit. */
  bodyLimit: AppMiddleware;
  /** Serves the built UI with an `index.html` fallback; absent when no web root is configured. */
  staticUi?: AppMiddleware;
  notFound: NotFoundHandler<AppEnv>;
  /** Maps `AppError` to `{ error: { code, message } }`; everything else to a generic 500. */
  onError: ErrorHandler<AppEnv>;
}

/** Everything `createApp` wires together. Tests pass fakes from `testing/`. */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  storage: Storage;
  settings: SettingsService;
  providers: ProviderRegistry;
  asks: AskManager;
  auth: AuthService;
  tls: TlsProvider;
  http: HttpLayer;
}
