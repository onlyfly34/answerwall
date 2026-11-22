import { createSignal } from 'solid-js';
import type { ProviderStatus } from '@answerwall/core/protocol';
import type { ApiClient, ProvidersStore } from '../contracts/services.ts';

export function createProvidersStore(
  api: Pick<ApiClient, 'listProviders' | 'refreshProviders'>,
): ProvidersStore {
  const [providers, setProviders] = createSignal<ProviderStatus[]>([]);
  const [inFlight, setInFlight] = createSignal(0);
  /** Only the most recently started request may write: an older answer is stale. */
  let latest = 0;

  async function run(request: () => Promise<ProviderStatus[]>): Promise<void> {
    const ticket = ++latest;
    setInFlight((count) => count + 1);
    try {
      const statuses = await request();
      if (ticket === latest) setProviders(statuses);
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
