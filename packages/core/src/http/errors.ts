import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from '../contracts/index.ts';
import type { AppEnv, Logger } from '../contracts/index.ts';
import type { ApiErrorBody, ApiErrorCode } from '../protocol/index.ts';

const body = (code: ApiErrorCode, message: string): ApiErrorBody => ({ error: { code, message } });

export function createErrorHandlers(logger: Logger): {
  notFound: NotFoundHandler<AppEnv>;
  onError: ErrorHandler<AppEnv>;
} {
  return {
    notFound: (c) => c.json(body('not_found', 'Not found'), 404),
    onError: (error, c) => {
      if (error instanceof AppError) {
        return c.json(body(error.code, error.message), error.status as ContentfulStatusCode);
      }
      if (error instanceof HTTPException && error.status < 500) {
        return c.json(body('bad_request', 'Bad request'), error.status);
      }
      // Only the error's class is logged: its message may quote request data.
      logger.error('unhandled error', { path: c.req.path, error: error.name });
      return c.json(body('internal', 'Internal server error'), 500);
    },
  };
}
