import { z } from 'zod';

/** Why a slot failed. Produced by provider adapters and by the runner. */
export const PROVIDER_ERROR_CODES = [
  'not_installed',
  'not_logged_in',
  'quota',
  'rate_limited',
  'model_not_found',
  'timeout',
  'cancelled',
  'spawn_failed',
  'bad_output',
  'network',
  'prompt_too_long',
  'unsupported',
  'unknown',
] as const;
export const ProviderErrorCodeSchema = z.enum(PROVIDER_ERROR_CODES);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

/** Why an HTTP request was rejected. Each code maps to one HTTP status on the server. */
export const API_ERROR_CODES = [
  'bad_request',
  'too_many_targets',
  'unknown_provider',
  'provider_disabled',
  'web_client_required',
  'unauthorized',
  'invalid_code',
  'forbidden',
  'not_found',
  'conflict',
  'device_limit',
  'payload_too_large',
  'prompt_too_long',
  'unsupported_media_type',
  'rate_limited',
  'too_many_asks',
  'queue_full',
  'internal',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
