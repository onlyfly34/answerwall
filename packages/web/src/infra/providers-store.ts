import { createSignal } from 'solid-js';
import type { ProviderStatus } from '@answerwall/core/protocol';
import type { ApiClient, ProvidersStore } from '../contracts/services.ts';

/** How long to wait before reading again while the server is still detecting. */
export const FOLLOW_UP_MS = 1_000;

export interface ProvidersStoreOptions {
  /**
   * Keep the web providers in the list. Only a page that can show web cells
   * (the extension's wall page) does; everywhere else they are left out, so
   * nothing offers a cell this page could not run.
   */
  webProviders?: boolean;
}

export function createProvidersStore(
  api: Pick<ApiClient, 'listProviders' | 'refreshProviders'>,
  options: ProvidersStoreOptions = {},
): ProvidersStore {
  const [all, setProviders] = createSignal<ProviderStatus[]>([]);
  const providers = (): ProviderStatus[] =>
    options.webProviders === true
      ? all()
      : all().filter((status) => status.instance.kind !== 'web');
  const [inFlight, setInFlight] = createSignal(0);
  /** Only the most recently started request may write: an older answer is stale. */
  let latest = 0;
  let followUp: ReturnType<typeof setTimeout> | undefined;

  /**
   * A detection the server had not finished when it answered (the one of its
   * start, or another device's refresh) would never reach this page, so the
   * cached statuses are read again until none is being detected. The read
   * starts nothing on the server and is not shown as activity.
   */
  function accept(statuses: ProviderStatus[]): void {
    setProviders(statuses);
    if (!statuses.some((status) => status.detecting)) return;
    followUp = setTimeout(() => {
      followUp = undefined;
      const ticket = ++latest;
      api.listProviders().then(
        (next) => {
          if (ticket === latest) accept(next);
        },
        // The page keeps what it has; the next load or refresh reports its own failure.
        () => undefined,
      );
    }, FOLLOW_UP_MS);
  }

  async function run(request: () => Promise<ProviderStatus[]>): Promise<void> {
    const ticket = ++latest;
    clearTimeout(followUp);
    followUp = undefined;
    setInFlight((count) => count + 1);
    try {
      const statuses = await request();
      if (ticket === latest) accept(statuses);
    } finally {
      setInFlight((count) => count - 1);
    }
  }

  return {
    providers,
    busy: () => inFlight() > 0,
    load: () => run(() => api.listProviders()),
    refresh: (providerId) => run(() => api.refreshProviders(providerId)),
  };
}
