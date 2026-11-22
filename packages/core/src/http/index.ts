import type { AppConfig, Clock, HttpLayer, Logger, SettingsService } from '../contracts/index.ts';
import { LIMIT_SPECS } from '../protocol/index.ts';
import { createAddressMatcher } from './addresses.ts';
import { createBodyLimit } from './body-limit.ts';
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
    originGuard: createOriginGuard(config.publicOrigins, () => settings.get().webCells),
    authRateLimit: createAuthRateLimit({
      limit: () => settings.get().limits.authFailuresPerMinute,
      limiter,
    }),
    bodyLimit: createBodyLimit(settings),
    ...(config.webRoot === undefined ? {} : { staticUi: createStaticUi(config.webRoot) }),
    ...createErrorHandlers(logger),
  };
}
