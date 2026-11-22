/**
 * The boundary between the app infrastructure (shell, API client, stores,
 * i18n) and the wall. The wall consumes these interfaces through
 * `useServices()` and never imports the infrastructure directly.
 */
import { createContext, useContext } from 'solid-js';
import type { Accessor } from 'solid-js';
import type {
  ApiErrorCode,
  AskRequest,
  AskResponse,
  AskSnapshot,
  CancelResponse,
  DevicesResponse,
  HistoryPage,
  HistoryQuery,
  Language,
  Meta,
  PairRequest,
  PairingCodeResponse,
  Preset,
  PresetInput,
  ProviderStatus,
  ServerInfo,
  SessionRequest,
  SessionResponse,
  Settings,
  SettingsPatch,
  SettingsResponse,
  WebResultRequest,
  WebResultResponse,
} from '@answerwall/core/protocol';
import type { MessageKey } from './messages.ts';

/**
 * Every failed API call rejects with this. `network`: no response at all.
 * `invalid_response`: the body did not match the protocol.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode | 'network' | 'invalid_response';
  /** HTTP status; 0 when there was no response. */
  readonly status: number;

  constructor(code: ApiError['code'], status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** One method per endpoint. Responses are validated against the protocol schemas. */
export interface ApiClient {
  getMeta(): Promise<Meta>;
  pair(request: PairRequest): Promise<SessionResponse>;
  signIn(request: SessionRequest): Promise<SessionResponse>;
  logout(): Promise<void>;
  listDevices(): Promise<DevicesResponse>;
  revokeDevice(deviceId: string): Promise<void>;
  createPairingCode(): Promise<PairingCodeResponse>;
  listProviders(): Promise<ProviderStatus[]>;
  refreshProviders(providerId?: string): Promise<ProviderStatus[]>;
  ask(request: AskRequest): Promise<AskResponse>;
  getAsk(askId: string): Promise<AskSnapshot>;
  cancelAsk(askId: string, slotId?: string): Promise<CancelResponse>;
  /**
   * The one result of a web slot of an ask this client created with
   * `runsWebSlots`. The same result may be sent again after a lost answer;
   * `conflict` means the slot ended some other way (cancelled elsewhere,
   * timed out) or already has another result.
   */
  submitWebResult(
    askId: string,
    slotId: string,
    result: WebResultRequest,
  ): Promise<WebResultResponse>;
  listPresets(): Promise<Preset[]>;
  savePreset(presetId: string, input: PresetInput): Promise<Preset>;
  deletePreset(presetId: string): Promise<void>;
  listHistory(query?: Partial<HistoryQuery>): Promise<HistoryPage>;
  getHistoryEntry(askId: string): Promise<AskSnapshot>;
  deleteHistoryEntry(askId: string): Promise<void>;
  getSettings(): Promise<SettingsResponse>;
  updateSettings(patch: SettingsPatch): Promise<SettingsResponse>;
}

/**
 * `connecting`: the first attempt. `live`: receiving events. `reconnecting`:
 * interrupted; the stream resumes on its own. `closed`: the ask finished (a
 * terminal event arrived) or `close()` was called. `failed`: gave up for
 * good; `error` says why.
 */
export type StreamConnection = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'failed';

/** One ask being followed over the event stream. */
export interface AskStream {
  readonly askId: string;
  /**
   * The ask's state, kept current from the stream. Backed by a Solid store:
   * reading `snapshot()?.slots[i].text` in a component tracks just that field.
   * `undefined` until the first data arrives.
   */
  snapshot: Accessor<AskSnapshot | undefined>;
  /**
   * A terminal event (`isTerminalStreamEvent`: `ask_done`, or a `snapshot`
   * whose status is `done`) makes it `closed`, and the stream never
   * reconnects after one. A connection that drops without one is resumed
   * from the last `seq`.
   */
  connection: Accessor<StreamConnection>;
  /**
   * Set exactly when `connection` is `failed`: the server answered the
   * stream request with an error (404: the ask no longer exists) or with
   * something that is not the protocol. Unreachable servers are retried, not
   * reported here. The store also passes a 401 to `notify.reportError`.
   */
  error: Accessor<ApiError | undefined>;
  /** Stops following. Never cancels the ask. */
  close(): void;
}

export interface AskStreamStore {
  /** The ask shown on the wall, if any. */
  current: Accessor<AskStream | undefined>;
  /** Submits an ask and follows it as `current`. Rejects with `ApiError`. */
  submit(request: AskRequest): Promise<AskStream>;
  /** Follows an existing ask (after a reload, or a running ask opened from history) as `current`. */
  follow(askId: string): AskStream;
  /** Cancels one slot of the current ask, or all of its unfinished slots. */
  cancel(slotId?: string): Promise<void>;
  /** Stops following and empties `current`. */
  clear(): void;
}

export interface SettingsStore {
  /** `undefined` until loaded. */
  settings: Accessor<Settings | undefined>;
  server: Accessor<ServerInfo | undefined>;
  load(): Promise<void>;
  update(patch: SettingsPatch): Promise<void>;
}

export interface ProvidersStore {
  providers: Accessor<ProviderStatus[]>;
  /** A load or refresh is in flight. */
  busy: Accessor<boolean>;
  /** Reads the cached statuses; runs nothing on the server. */
  load(): Promise<void>;
  /** Asks the server to re-detect one provider or all enabled ones. */
  refresh(providerId?: string): Promise<void>;
}

/** Looks up a message in the current language, replacing `{name}` placeholders. */
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface I18n {
  t: Translate;
  language: Accessor<Language>;
  setLanguage(language: Language): void;
}

export interface Toast {
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface Notifier {
  toast(toast: Toast): void;
  /** Shows a translated message for any thrown value; an `ApiError` with status 401 returns to sign-in instead. */
  reportError(error: unknown): void;
}

/**
 * The shell mounts `WallPage` and `HistoryPage` only after `settings.load()`
 * and `providers.load()` have succeeded, so inside them `settings.settings()`
 * is defined and `providers.providers()` holds the cached statuses.
 */
export interface AppServices {
  /**
   * `undefined` until the first `GET /api/meta` has answered. When the
   * server's `apiVersion` differs from the `API_VERSION` this bundle was
   * built with, or its `version` from the bundle's own, the shell is stale:
   * it revalidates its cached assets and reloads instead of mounting pages.
   */
  meta: Accessor<Meta | undefined>;
  api: ApiClient;
  asks: AskStreamStore;
  settings: SettingsStore;
  providers: ProvidersStore;
  i18n: I18n;
  notify: Notifier;
}

export const ServicesContext = createContext<AppServices>();

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('ServicesContext is not provided');
  return services;
}
