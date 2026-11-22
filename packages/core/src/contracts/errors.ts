import type { ApiErrorCode } from '../protocol/index.ts';

export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  too_many_targets: 400,
  unknown_provider: 400,
  provider_disabled: 400,
  web_client_required: 400,
  unauthorized: 401,
  invalid_code: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  device_limit: 409,
  payload_too_large: 413,
  prompt_too_long: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  too_many_asks: 429,
  queue_full: 429,
  internal: 500,
};

/**
 * The only error type that reaches a client with its own code and message.
 * Anything else thrown inside a request becomes a generic `internal` error.
 * The message is shown to the user: no paths, tokens or account identifiers.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}
