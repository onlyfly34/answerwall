import { BRAND } from '@answerwall/core/protocol';
import { SERVICE_WORKER_PATH, SKIP_WAITING_MESSAGE } from './routing.ts';

export const UPDATE_ATTEMPT_KEY = `${BRAND.slug}.update-attempt`;
/** A worker that has not taken over by then is not waited for; the page reloads anyway. */
export const UPDATE_TIMEOUT_MS = 8_000;

/** Replaces a stale app shell with the one the server now serves. */
export interface Updater {
  /**
   * Fetches the new service worker, lets it take over and reloads the page.
   * Returns `false` without reloading when that was already tried for
   * `target` in this tab, so a server and bundle that cannot agree do not
   * reload forever; `force` (the user asked) tries regardless.
   */
  apply(target: string, force?: boolean): Promise<boolean>;
  /** The shell is current: forget earlier attempts. */
  settled(): void;
}

type Container = Pick<ServiceWorkerContainer, 'getRegistration' | 'addEventListener'>;

export interface UpdaterEnvironment {
  /** `undefined` where service workers are unavailable (plain HTTP on a LAN, private modes). */
  serviceWorker?: Container | undefined;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  reload(): void;
  timeoutMs?: number;
}

function waitForInstalled(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'installed' || worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' || worker.state === 'activated') resolve();
      else if (worker.state === 'redundant') reject(new Error('The new worker failed to install'));
    });
  });
}

/** Resolves once the newest worker controls this page; at once when nothing changed. */
async function activateNewestWorker(container: Container): Promise<void> {
  const registration = await container.getRegistration();
  if (!registration) return;
  await registration.update();
  const next = registration.installing ?? registration.waiting;
  if (!next) return;
  const controlled = new Promise<void>((resolve) => {
    container.addEventListener('controllerchange', () => resolve(), { once: true });
  });
  await waitForInstalled(next);
  if (next.state === 'activated') return;
  next.postMessage(SKIP_WAITING_MESSAGE);
  await controlled;
}

export function createUpdater(environment: UpdaterEnvironment): Updater {
  const { storage, serviceWorker } = environment;
  const timeoutMs = environment.timeoutMs ?? UPDATE_TIMEOUT_MS;

  /** Without working storage the attempt cannot be remembered, so it counts as made. */
  function alreadyTried(target: string): boolean {
    try {
      if (!storage) return true;
      if (storage.getItem(UPDATE_ATTEMPT_KEY) === target) return true;
      storage.setItem(UPDATE_ATTEMPT_KEY, target);
      return false;
    } catch {
      return true;
    }
  }

  return {
    async apply(target, force = false) {
      if (alreadyTried(target) && !force) return false;
      if (serviceWorker) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        // Offline, or a worker that fails to install: the plain reload still helps.
        await Promise.race([activateNewestWorker(serviceWorker).catch(() => undefined), timeout]);
        clearTimeout(timer);
      }
      environment.reload();
      return true;
    },
    settled() {
      try {
        storage?.removeItem(UPDATE_ATTEMPT_KEY);
      } catch {
        // Nothing was stored either.
      }
    },
  };
}

function browserSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function createBrowserUpdater(): Updater {
  return createUpdater({
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    storage: browserSessionStorage(),
    reload: () => window.location.reload(),
  });
}

/**
 * Registers the worker once the page has loaded. Only in production builds:
 * the development server has no worker file. Registration fails quietly
 * where workers are not allowed; the app works without one.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () =>
    void navigator.serviceWorker
      .register(SERVICE_WORKER_PATH, { scope: '/' })
      .catch(() => undefined);
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
