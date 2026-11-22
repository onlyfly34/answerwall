import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from '../contracts/index.ts';
import type { AppEnv, Logger } from '../contracts/index.ts';
import type { ApiErrorBody, ApiErrorCode } from '../protocol/index.ts';

const body = (code: ApiErrorCode, message: string): ApiErrorBody => ({ error: { code, message } });

/** Client errors raised by the framework itself, by status. Their own messages are not passed on. */
const FRAMEWORK_ERRORS: Readonly<Record<number, readonly [ApiErrorCode, string]>> = {
  401: ['unauthorized', 'Sign in to continue'],
  403: ['forbidden', 'Forbidden'],
  404: ['not_found', 'Not found'],
  413: ['payload_too_large', 'Request body is too large'],
  415: ['unsupported_media_type', 'Unsupported media type'],
  429: ['rate_limited', 'Too many requests'],
};

/**
 * The only two places a response body for a failed request is built. An
 * `AppError` carries a message written for the user; anything else is
 * reduced to a fixed text, so no stack trace, file path or internal message
 * can reach a client.
 */
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
      if (error instanceof HTTPException && error.status >= 400 && error.status < 500) {
        const [code, message] = FRAMEWORK_ERRORS[error.status] ?? ['bad_request', 'Bad request'];
        return c.json(body(code, message), error.status);
      }
      // Only the error's class is logged: its message may quote request data.
      logger.error('unhandled error', { path: c.req.path, error: error.name });
      return c.json(body('internal', 'Internal server error'), 500);
    },
  };
}
