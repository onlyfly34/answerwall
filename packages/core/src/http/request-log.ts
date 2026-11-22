import type { AppMiddleware, Clock, Logger } from '../contracts/index.ts';

/**
 * One entry per request: method, path, status, duration and client address.
 * Never the query string, a header or a body. API requests are logged at
 * `info`, static files at `debug`, server errors at `error`.
 */
export function createRequestLog(deps: { clock: Clock; logger: Logger }): AppMiddleware {
  const { clock, logger } = deps;
  return async (c, next) => {
    const startedAt = clock.now();
    await next();
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: clock.now() - startedAt,
      // Unset when the request was answered before clientInfo ran.
      client: (c.var.client as { address: string } | undefined)?.address,
    };
    if (status >= 500) logger.error('request', fields);
    else if (c.req.path.startsWith('/api/')) logger.info('request', fields);
    else logger.debug('request', fields);
  };
}
