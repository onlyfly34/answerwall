import type { MessageKey } from '../contracts/messages.ts';
import { ApiError } from '../contracts/services.ts';
import type { Translate } from '../contracts/services.ts';

const ERROR_KEYS: Record<ApiError['code'], MessageKey> = {
  network: 'app.error.network',
  invalid_response: 'app.error.invalidResponse',
  bad_request: 'app.error.badRequest',
  too_many_targets: 'app.error.tooManyTargets',
  unknown_provider: 'app.error.unknownProvider',
  provider_disabled: 'app.error.providerDisabled',
  web_client_required: 'app.error.webClientRequired',
  unauthorized: 'app.error.unauthorized',
  invalid_code: 'app.error.invalidCode',
  forbidden: 'app.error.forbidden',
  not_found: 'app.error.notFound',
  conflict: 'app.error.conflict',
  device_limit: 'app.error.deviceLimit',
  payload_too_large: 'app.error.payloadTooLarge',
  prompt_too_long: 'app.error.promptTooLong',
  unsupported_media_type: 'app.error.unsupportedMediaType',
  rate_limited: 'app.error.rateLimited',
  too_many_asks: 'app.error.tooManyAsks',
  queue_full: 'app.error.queueFull',
  internal: 'app.error.internal',
};

/**
 * The message shown for any thrown value. The server's own wording is added
 * only where it carries the detail the user needs (which field was refused).
 */
export function errorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t('app.error.unexpected');
  return t(ERROR_KEYS[error.code], { detail: error.message });
}
