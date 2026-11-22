import { bodyLimit } from 'hono/body-limit';
import { AppError } from '../contracts/index.ts';
import type {
  AppConfig,
  AppMiddleware,
  Clock,
  HttpLayer,
  Logger,
  SettingsService,
} from '../contracts/index.ts';
import { LIMIT_SPECS } from '../protocol/index.ts';
import { createAddressMatcher } from './addresses.ts';
import { createClientInfo } from './client-info.ts';
import { createErrorHandlers } from './errors.ts';
import { createHostGuard, createOriginGuard, createPeerGuard } from './guards.ts';
import { createAuthRateLimit, createFailureLimiter } from './rate-limit.ts';
import { createRequestLog } from './request-log.ts';
import { createSecurityHeaders } from './security-headers.ts';
import { createStaticUi } from './static-ui.ts';

export { createErrorHandlers } from './errors.ts';
export { CONTENT_SECURITY_POLICY } from './security-headers.ts';

export interface HttpLayerDeps {
  config: AppConfig;
  /** Source of the request body and failed-auth limits. */
  settings: SettingsService;
  clock: Clock;
  logger: Logger;
}

function createBodyLimit(settings: SettingsService): AppMiddleware {
  const tooLarge = (): never => {
    throw new AppError('payload_too_large', 'Request body is too large');
  };
  // The limit is a setting, so it is read for every request.
  return (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const maxSize = settings.get().limits.maxRequestBodyBytes;
    return bodyLimit({ maxSize, onError: tooLarge })(c, next);
  };
}

/**
 * Builds the guards from the configuration.
 * @throws Error when a trusted proxy entry or a public origin is malformed.
 */
export function createHttpLayer({ config, settings, clock, logger }: HttpLayerDeps): HttpLayer {
  const isTrustedProxy = createAddressMatcher(config.trustedProxies);
  const limiter = createFailureLimiter({
    clock,
    maxFailuresKept: LIMIT_SPECS.authFailuresPerMinute.max,
  });

  return {
    requestLog: createRequestLog({ clock, logger }),
    securityHeaders: createSecurityHeaders(config.publicOrigins),
    clientInfo: createClientInfo(isTrustedProxy),
    peerGuard: createPeerGuard(config, isTrustedProxy),
    hostGuard: createHostGuard(config.publicOrigins),
    originGuard: createOriginGuard(config.publicOrigins),
    authRateLimit: createAuthRateLimit({
      limit: () => settings.get().limits.authFailuresPerMinute,
      limiter,
    }),
    bodyLimit: createBodyLimit(settings),
    ...(config.webRoot === undefined ? {} : { staticUi: createStaticUi(config.webRoot) }),
    ...createErrorHandlers(logger),
  };
}
