import { createSignal } from 'solid-js';
import type { Meta, ProviderStatus, ServerInfo, Settings } from '@answerwall/core/protocol';
import type { ApiClient, AppServices, AskStream } from '../contracts/services.ts';
import { createApiClient } from './api.ts';
import { createI18n } from './i18n.ts';

const notBuilt = (what: string) => (): never => {
  throw new Error(`${what} is not implemented yet`);
};

/**
 * Scaffold wiring: the API client and translator work, the stores are empty
 * shells with the final shape.
 */
export function createServices(api: ApiClient = createApiClient()): AppServices {
  const [meta, setMeta] = createSignal<Meta>();
  const [current] = createSignal<AskStream>();
  const [settings] = createSignal<Settings>();
  const [server] = createSignal<ServerInfo>();
  const [providers] = createSignal<ProviderStatus[]>([]);
  const [busy] = createSignal(false);

  const services: AppServices = {
    meta,
    api,
    asks: {
      current,
      submit: notBuilt('asks.submit'),
      follow: notBuilt('asks.follow'),
      cancel: notBuilt('asks.cancel'),
      clear: notBuilt('asks.clear'),
    },
    settings: {
      settings,
      server,
      load: notBuilt('settings.load'),
      update: notBuilt('settings.update'),
    },
    providers: {
      providers,
      busy,
      load: notBuilt('providers.load'),
      refresh: notBuilt('providers.refresh'),
    },
    i18n: createI18n(),
    notify: {
      toast: ({ kind, message }) => console.info(`[${kind}] ${message}`),
      reportError: (error) => console.error(error),
    },
  };

  api.getMeta().then(setMeta, (error: unknown) => services.notify.reportError(error));
  return services;
}
