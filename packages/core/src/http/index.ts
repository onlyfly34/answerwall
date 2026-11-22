import type {
  AppConfig,
  AppMiddleware,
  Clock,
  HttpLayer,
  Logger,
  SettingsService,
} from '../contracts/index.ts';
import { createErrorHandlers } from './errors.ts';

export { createErrorHandlers } from './errors.ts';

export interface HttpLayerDeps {
  config: AppConfig;
  /** Source of the request body and failed-auth limits. */
  settings: SettingsService;
  clock: Clock;
  logger: Logger;
}

const pass: AppMiddleware = (_c, next) => next();

/**
 * Scaffold: error mapping is real, every guard still lets requests through.
 * Nothing is exposed by that, because the auth service rejects every
 * non-public route until it exists.
 */
export function createHttpLayer({ logger }: HttpLayerDeps): HttpLayer {
  return {
    requestLog: pass,
    clientInfo: (c, next) => {
      c.set('client', {
        address: c.env.incoming?.socket.remoteAddress ?? 'unknown',
        secure: false,
      });
      return next();
    },
    peerGuard: pass,
    hostGuard: pass,
    securityHeaders: pass,
    originGuard: pass,
    authRateLimit: pass,
    bodyLimit: pass,
    ...createErrorHandlers(logger),
  };
}
