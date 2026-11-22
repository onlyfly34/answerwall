import { SSE_RESUME_QUERY } from './stream.ts';

const id = encodeURIComponent;

/** Every HTTP endpoint, for clients. The server registers the same paths in `routes/`. */
export const API_PATHS = {
  meta: '/api/meta',
  authPair: '/api/auth/pair',
  authSession: '/api/auth/session',
  authLogout: '/api/auth/logout',
  authDevices: '/api/auth/devices',
  authDevice: (deviceId: string) => `/api/auth/devices/${id(deviceId)}`,
  authPairingCodes: '/api/auth/pairing-codes',
  providers: '/api/providers',
  providersRefresh: '/api/providers/refresh',
  ask: '/api/ask',
  askSnapshot: (askId: string) => `/api/ask/${id(askId)}`,
  askStream: (askId: string, after?: number) =>
    `/api/ask/${id(askId)}/stream${after === undefined ? '' : `?${SSE_RESUME_QUERY}=${after}`}`,
  askCancel: (askId: string) => `/api/ask/${id(askId)}/cancel`,
  presets: '/api/presets',
  preset: (presetId: string) => `/api/presets/${id(presetId)}`,
  history: '/api/history',
  historyEntry: (askId: string) => `/api/history/${id(askId)}`,
  settings: '/api/settings',
} as const;
