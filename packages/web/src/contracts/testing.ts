/**
 * In-memory `AppServices` for unit tests of pages and components. Nothing
 * here talks to a server: tests drive the state and inspect what was called.
 */
import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import {
  API_VERSION,
  applyStreamEvent,
  BRAND,
  createDefaultSettings,
  initialAskSnapshot,
  isTerminalStreamEvent,
  SettingsSchema,
  webSearchSupport,
} from '@answerwall/core/protocol';
import type {
  AskRequest,
  AskSnapshot,
  Language,
  Meta,
  ProviderInstance,
  ProviderStatus,
  ServerInfo,
  Settings,
  SettingsPatch,
  StreamEvent,
} from '@answerwall/core/protocol';
import { createI18n } from './i18n.ts';
import { ApiError } from './services.ts';
import type {
  ApiClient,
  AppServices,
  AskStream,
  AskStreamStore,
  StreamConnection,
  Toast,
  WebCellHost,
} from './services.ts';

export interface FakeAskStream extends AskStream {
  /**
   * Folds an event into the snapshot exactly as the real store does. Events
   * need increasing `seq`. A terminal event closes the connection.
   */
  apply(event: StreamEvent): void;
  setConnection(connection: StreamConnection): void;
  /** Ends the stream as `failed` with this error. */
  fail(error: ApiError): void;
}

export function createFakeAskStream(askId: string, initial?: AskSnapshot): FakeAskStream {
  const [state, setState] = createStore<{ snapshot: AskSnapshot | undefined }>({
    snapshot: initial && structuredClone(initial),
  });
  const [connection, setConnection] = createSignal<StreamConnection>(
    initial ? 'live' : 'connecting',
  );
  const [error, setError] = createSignal<ApiError>();
  return {
    askId,
    snapshot: () => state.snapshot,
    connection,
    error,
    close: () => setConnection('closed'),
    setConnection,
    apply(event) {
      setState(
        produce((draft) => {
          if (event.type === 'snapshot') draft.snapshot = structuredClone(event.snapshot);
          else if (draft.snapshot) applyStreamEvent(draft.snapshot, event);
        }),
      );
      setConnection(isTerminalStreamEvent(event) ? 'closed' : 'live');
    },
    fail(failure) {
      setError(failure);
      setConnection('failed');
    },
  };
}

export interface FakeAskStreamStore extends AskStreamStore {
  current: Accessor<FakeAskStream | undefined>;
  /** Follows a new ask whose slots are all queued; the test then drives it with `apply`. */
  submit(request: AskRequest): Promise<FakeAskStream>;
  /** Follows an ask with no data yet; send it a `snapshot` event. */
  follow(askId: string): FakeAskStream;
  /** Every request passed to `submit`, in order. */
  readonly submitted: AskRequest[];
  /** The `slotId` argument of every `cancel` call. */
  readonly cancelled: (string | undefined)[];
}

export interface FakeServices extends AppServices {
  asks: FakeAskStreamStore;
  setProviders(providers: ProviderStatus[]): void;
  /** Every `api` call, in order. */
  readonly apiCalls: { method: keyof ApiClient; args: unknown[] }[];
  /** Every patch passed to `settings.update`; each is also applied to `settings.settings()`. */
  readonly settingsUpdates: SettingsPatch[];
  /** The `providerId` argument of every `providers.refresh` call. */
  readonly refreshes: (string | undefined)[];
  readonly toasts: Toast[];
  /** Everything passed to `notify.reportError`. */
  readonly errors: unknown[];
}

export interface FakeServicesOptions {
  meta?: Meta;
  settings?: Settings;
  server?: ServerInfo;
  /** Default: every provider of `settings`, installed and logged in. */
  providers?: ProviderStatus[];
  language?: Language;
  /** Handlers for the `api` methods the test needs; any other call rejects. */
  api?: Partial<ApiClient>;
  /** Makes the page one that can frame the vendors' sites. */
  webCells?: WebCellHost;
}

/** A provider that is installed, logged in and streams token by token. */
export function readyProviderStatus(instance: ProviderInstance): ProviderStatus {
  return {
    instance,
    detection: { installed: true, loggedIn: 'yes', billing: 'subscription', streaming: 'token' },
    detectedAt: 0,
    detecting: false,
    models: instance.models.map((id) => ({ id })),
    toolAccess: 'disabled',
    webSearch: webSearchSupport(instance.kind),
  };
}

/** The server's merge rules; an invalid result throws, as the server would refuse it. */
function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    language: patch.language ?? current.language,
    providers:
      patch.providers?.map((input): ProviderInstance => {
        if (input.kind !== 'openai-compat') return input;
        const { apiKey, ...instance } = input;
        const stored = current.providers.find((p) => p.id === input.id);
        const hadKey = stored?.kind === 'openai-compat' && stored.hasApiKey;
        return { ...instance, hasApiKey: apiKey === undefined ? hadKey : apiKey !== null };
      }) ?? current.providers,
    limits: { ...current.limits, ...patch.limits },
    webCells: { ...current.webCells, ...patch.webCells },
    layout: { ...current.layout, ...patch.layout },
    updateCheck: patch.updateCheck ?? current.updateCheck,
  });
}

export function createFakeServices(options: FakeServicesOptions = {}): FakeServices {
  const [meta] = createSignal<Meta | undefined>(
    options.meta ?? {
      name: BRAND.name,
      version: '0.0.0-test',
      apiVersion: API_VERSION,
      mode: 'server',
      tls: 'off',
      authRequired: true,
    },
  );
  const initialSettings = options.settings ?? createDefaultSettings();
  const [settings, setSettings] = createSignal<Settings | undefined>(initialSettings);
  const [server] = createSignal<ServerInfo | undefined>(
    options.server ?? {
      mode: 'server',
      tls: { mode: 'off', insecure: false, caCertificatePem: null },
      publicOrigins: [],
    },
  );
  const [providers, setProviders] = createSignal<ProviderStatus[]>(
    options.providers ?? initialSettings.providers.map(readyProviderStatus),
  );
  const [busy] = createSignal(false);
  const [current, setCurrent] = createSignal<FakeAskStream>();

  const submitted: AskRequest[] = [];
  const cancelled: (string | undefined)[] = [];
  const apiCalls: FakeServices['apiCalls'] = [];
  const settingsUpdates: SettingsPatch[] = [];
  const refreshes: (string | undefined)[] = [];
  const toasts: Toast[] = [];
  const errors: unknown[] = [];

  const api = new Proxy({} as ApiClient, {
    get:
      (_target, name) =>
      (...args: unknown[]): Promise<unknown> => {
        const method = name as keyof ApiClient;
        apiCalls.push({ method, args });
        const handler = options.api?.[method] as
          ((...a: unknown[]) => Promise<unknown>) | undefined;
        return handler
          ? handler(...args)
          : Promise.reject(new Error(`createFakeServices: no handler for api.${method}`));
      },
  });

  return {
    meta,
    api,
    asks: {
      current,
      submitted,
      cancelled,
      async submit(request) {
        submitted.push(request);
        const targets = request.targets.map((target) => {
          const provider = providers().find((p) => p.instance.id === target.providerId);
          if (!provider) {
            throw new ApiError('unknown_provider', 400, `No provider "${target.providerId}"`);
          }
          return { ...target, kind: provider.instance.kind };
        });
        const askId = `ask-${submitted.length}`;
        const stream = createFakeAskStream(
          askId,
          initialAskSnapshot({
            askId,
            conversationId: request.conversationId ?? `conversation-${submitted.length}`,
            prompt: request.prompt,
            createdAt: 0,
            targets,
          }),
        );
        setCurrent(stream);
        return stream;
      },
      follow(askId) {
        const stream = createFakeAskStream(askId);
        setCurrent(stream);
        return stream;
      },
      async cancel(slotId) {
        cancelled.push(slotId);
      },
      clear() {
        current()?.close();
        setCurrent(undefined);
      },
    },
    settings: {
      settings,
      server,
      async load() {},
      async update(patch) {
        settingsUpdates.push(patch);
        setSettings((previous) => previous && applySettingsPatch(previous, patch));
      },
    },
    providers: {
      providers,
      busy,
      async load() {},
      async refresh(providerId) {
        refreshes.push(providerId);
      },
    },
    i18n: createI18n(options.language),
    notify: {
      toast: (toast) => void toasts.push(toast),
      reportError: (error) => void errors.push(error),
    },
    ...(options.webCells ? { webCells: options.webCells } : {}),
    setProviders,
    apiCalls,
    settingsUpdates,
    refreshes,
    toasts,
    errors,
  };
}
