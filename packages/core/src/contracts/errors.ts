import type { ApiErrorCode } from '../protocol/index.ts';

export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  too_many_targets: 400,
  unknown_provider: 400,
  provider_disabled: 400,
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
  not_implemented: 501,
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

export class NotImplementedError extends AppError {
  constructor(what: string) {
    super('not_implemented', `${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Placeholder for a unit that has not been built: every member that is not in
 * `implemented` is a function (or a namespace of functions) that throws
 * {@link NotImplementedError}. Deleted once every unit has landed.
 */
export function unimplemented<T extends object>(unit: string, implemented: Partial<T> = {}): T {
  const missing = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        typeof key === 'symbol' || key === 'then' ? undefined : missing(`${path}.${key}`),
      apply: () => {
        throw new NotImplementedError(path);
      },
    });
  return new Proxy(implemented, {
    get: (target, key, receiver) =>
      typeof key === 'symbol' || key === 'then' || key in target
        ? Reflect.get(target, key, receiver)
        : missing(`${unit}.${key}`),
  }) as T;
}
