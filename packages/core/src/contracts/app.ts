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
  /** The socket's remote address. `peerGuard` and the trusted-proxy check judge this one. */
  peer: string;
  /**
   * The client's IP address: the forwarded one when `peer` is a trusted
   * proxy, otherwise `peer`. Rate limiting keys on it.
   */
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
    /**
     * Set to `true` by `requireAuth` and the auth routes when the request
     * presented a credential that was rejected: a wrong pairing code, a wrong
     * token, an unknown bearer token or session cookie. A request without any
     * credential never sets it. `HttpLayer.authRateLimit` counts it.
     */
    authFailure?: boolean;
    /**
     * Set by `HttpLayer.originGuard` when the request's `Origin` is a browser
     * extension on the allowlist (`chrome-extension://<id>`). Such a client
     * never gets or uses the session cookie: the auth routes hand it its
     * token in the response body instead.
     */
    extensionOrigin?: string;
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
  /**
   * CSP and the other fixed response headers; never any `Access-Control-*`.
   * Runs before the guards, so their rejections carry the headers too.
   */
  securityHeaders: AppMiddleware;
  /** Sets `client`, honouring `X-Forwarded-*` only from trusted proxies. */
  clientInfo: AppMiddleware;
  /**
   * With TLS off on a non-loopback bind, refuses peers that are neither
   * loopback nor a trusted proxy. Reads only `c.var.client.peer`.
   */
  peerGuard: AppMiddleware;
  /** Rejects requests whose `Host` is not in the allowlist. */
  hostGuard: AppMiddleware;
  /**
   * Non-GET requests must have `Content-Type: application/json`, and:
   * - an `Origin` header, when present, must be one of the allowed origins;
   * - a request without `Origin` is accepted only when it has an
   *   `Authorization` header and no session cookie (a non-browser client).
   *
   * So browsers, and anything calling the public auth routes without a
   * bearer token, must send `Origin`.
   *
   * A request of any method whose `Origin` is a browser extension passes
   * only when web cells are switched on, the extension's id is on the
   * allowlist in the settings, and it carries no session cookie; the guard
   * then sets `extensionOrigin`. (Chromium sends that header on writes and
   * not on a `GET`.)
   */
  originGuard: AppMiddleware;
  /**
   * Refuses (`rate_limited`) a client address that exceeded the failed-auth
   * limit, and counts the requests that end with `authFailure` set. A 401
   * for a request that presented no credential is not counted, so a
   * signed-out browser cannot lock itself out of pairing.
   */
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
