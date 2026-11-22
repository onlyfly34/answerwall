import { createSignal } from 'solid-js';
import type { Meta } from '@answerwall/core/protocol';
import type { ApiClient, AppServices } from '../contracts/services.ts';
import { createBrowserUpdater } from '../pwa/updater.ts';
import type { Updater } from '../pwa/updater.ts';
import { createApiClient, defaultFetch } from './api.ts';
import type { Fetch } from './api.ts';
import { createAskStream } from './ask-stream.ts';
import type { AskStreamTuning } from './ask-stream.ts';
import { createAskStreamStore } from './ask-store.ts';
import { BUILD_VERSION } from './build-info.ts';
import { createPersistedI18n } from './language.ts';
import type { LanguageEnvironment } from './language.ts';
import { createNotifier } from './notifier.ts';
import type { ToastCenter } from './notifier.ts';
import { createProvidersStore } from './providers-store.ts';
import { createSettingsStore } from './settings-store.ts';
import { createShell } from './shell.ts';
import type { Shell } from './shell.ts';
import { pageVisibility } from './visibility.ts';
import type { Visibility } from './visibility.ts';

/** What the shell needs on top of the services the pages see. */
export interface ShellServices extends AppServices {
  notify: ToastCenter;
  shell: Shell;
}

export interface ServicesOptions {
  /** Used for every request, the event stream included. */
  fetch?: Fetch;
  /** Replaces the client built on `fetch`; the event stream still uses `fetch`. */
  api?: ApiClient;
  updater?: Updater;
  buildVersion?: string;
  visibility?: Visibility;
  language?: LanguageEnvironment;
  streamTuning?: Partial<AskStreamTuning>;
  random?: () => number;
}

/**
 * Builds the real services. Nothing is requested until `shell.start()`,
 * which loads the server's identity, then the settings and the providers:
 * the order the pages rely on.
 */
export function createServices(options: ServicesOptions = {}): ShellServices {
  const fetch = options.fetch ?? defaultFetch;
  const visibility = options.visibility ?? pageVisibility;
  const [meta, setMeta] = createSignal<Meta>();

  // The client and the notifier report to the shell, which is built from them.
  const signedOut = (): void => shell.signedOut();
  const api =
    options.api ??
    createApiClient({
      fetch,
      onUnauthorized: signedOut,
      onInvalidResponse: () => void shell.checkVersion(),
    });

  const i18n = createPersistedI18n(options.language);
  const notify = createNotifier({ t: i18n.t, onUnauthorized: signedOut });

  const providers = createProvidersStore(api);
  const settings = createSettingsStore({
    api,
    onChange(current, patch) {
      // The language is shared between devices: the server's value wins once it is known.
      if (current.language !== i18n.language()) i18n.setLanguage(current.language);
      // Statuses embed the provider configuration, so they follow every change to it.
      if (patch?.providers) providers.load().catch((error: unknown) => notify.reportError(error));
    },
  });

  const asks = createAskStreamStore({
    api,
    open: (askId, initial) =>
      createAskStream(
        askId,
        {
          api,
          fetch,
          notify,
          visibility,
          random: options.random ?? Math.random,
          ...(options.streamTuning ? { tuning: options.streamTuning } : {}),
        },
        initial,
      ),
  });

  const shell = createShell({
    api,
    settings,
    providers,
    asks,
    updater: options.updater ?? createBrowserUpdater(),
    buildVersion: options.buildVersion ?? BUILD_VERSION,
    setMeta,
  });

  return { meta, api, asks, settings, providers, i18n, notify, shell };
}
