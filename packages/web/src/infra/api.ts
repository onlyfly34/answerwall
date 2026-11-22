import type { z } from 'zod';
import {
  API_PATHS,
  ApiErrorBodySchema,
  AskResponseSchema,
  AskSnapshotSchema,
  CancelResponseSchema,
  DevicesResponseSchema,
  HistoryPageSchema,
  MetaSchema,
  OkResponseSchema,
  PairingCodeResponseSchema,
  PresetSchema,
  PresetsResponseSchema,
  ProvidersResponseSchema,
  SessionResponseSchema,
  SettingsResponseSchema,
} from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type { ApiClient } from '../contracts/services.ts';

type Fetch = typeof globalThis.fetch;

/** The API is same-origin; the session cookie travels on its own. */
export function createApiClient(fetch: Fetch = globalThis.fetch.bind(globalThis)): ApiClient {
  async function call<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        // Every non-GET request must be JSON, even without a payload.
        ...(method === 'GET'
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
      });
    } catch {
      throw new ApiError('network', 0, 'The server cannot be reached');
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = ApiErrorBodySchema.safeParse(payload);
      throw failure.success
        ? new ApiError(failure.data.error.code, response.status, failure.data.error.message)
        : new ApiError('invalid_response', response.status, `HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(
        'invalid_response',
        response.status,
        'Unexpected response from the server',
      );
    }
    return parsed.data;
  }

  const ok = async (method: string, path: string): Promise<void> => {
    await call(OkResponseSchema, method, path);
  };

  return {
    getMeta: () => call(MetaSchema, 'GET', API_PATHS.meta),
    pair: (request) => call(SessionResponseSchema, 'POST', API_PATHS.authPair, request),
    signIn: (request) => call(SessionResponseSchema, 'POST', API_PATHS.authSession, request),
    logout: () => ok('POST', API_PATHS.authLogout),
    listDevices: () => call(DevicesResponseSchema, 'GET', API_PATHS.authDevices),
    revokeDevice: (deviceId) => ok('DELETE', API_PATHS.authDevice(deviceId)),
    createPairingCode: () => call(PairingCodeResponseSchema, 'POST', API_PATHS.authPairingCodes),
    listProviders: async () =>
      (await call(ProvidersResponseSchema, 'GET', API_PATHS.providers)).providers,
    refreshProviders: async (id) =>
      (await call(ProvidersResponseSchema, 'POST', API_PATHS.providersRefresh, { id })).providers,
    ask: (request) => call(AskResponseSchema, 'POST', API_PATHS.ask, request),
    getAsk: (askId) => call(AskSnapshotSchema, 'GET', API_PATHS.askSnapshot(askId)),
    cancelAsk: (askId, slotId) =>
      call(CancelResponseSchema, 'POST', API_PATHS.askCancel(askId), { slotId }),
    listPresets: async () => (await call(PresetsResponseSchema, 'GET', API_PATHS.presets)).presets,
    savePreset: (presetId, input) => call(PresetSchema, 'PUT', API_PATHS.preset(presetId), input),
    deletePreset: (presetId) => ok('DELETE', API_PATHS.preset(presetId)),
    listHistory: (query = {}) => {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined) search.set(name, String(value));
      }
      const suffix = search.size > 0 ? `?${search.toString()}` : '';
      return call(HistoryPageSchema, 'GET', `${API_PATHS.history}${suffix}`);
    },
    getHistoryEntry: (askId) => call(AskSnapshotSchema, 'GET', API_PATHS.historyEntry(askId)),
    deleteHistoryEntry: (askId) => ok('DELETE', API_PATHS.historyEntry(askId)),
    getSettings: () => call(SettingsResponseSchema, 'GET', API_PATHS.settings),
    updateSettings: (patch) => call(SettingsResponseSchema, 'PUT', API_PATHS.settings, patch),
  };
}
