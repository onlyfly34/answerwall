import { batch, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { API_VERSION } from '@answerwall/core/protocol';
import type { Meta } from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type {
  ApiClient,
  AskStreamStore,
  ProvidersStore,
  SettingsStore,
} from '../contracts/services.ts';
import type { Updater } from '../pwa/updater.ts';

/**
 * `loading`: asking the server who it is and whether this device is signed
 * in. `unreachable`: no answer. `stale`: the server runs another version
 * than this bundle; the shell is being replaced. `signed-out`: the sign-in
 * page. `failed`: the server answered with an error. `ready`: settings and
 * providers are loaded and the pages are mounted.
 */
export type ShellPhase = 'loading' | 'unreachable' | 'stale' | 'signed-out' | 'failed' | 'ready';

export interface Shell {
  phase: Accessor<ShellPhase>;
  /** Set when `phase` is `failed`. */
  failure: Accessor<unknown>;
  /** A newer server was noticed while the pages were in use; the user chooses when to reload. */
  updateAvailable: Accessor<boolean>;
  /** Runs the start-up sequence; also the retry of `unreachable` and `failed`. */
  start(): Promise<void>;
  /** A sign-in succeeded: load what the pages need. */
  signedIn(): Promise<void>;
  /** The session is gone (a 401, a revoked device). */
  signedOut(): void;
  /** Ends the session on the server, then locally. Rejects with `ApiError`. */
  logout(): Promise<void>;
  /** Asks the server for its version again and raises `updateAvailable` when it changed. */
  checkVersion(): Promise<void>;
  /** Reloads into the server's version because the user asked. */
  applyUpdate(): Promise<void>;
}

export interface ShellDeps {
  api: Pick<ApiClient, 'getMeta' | 'logout'>;
  settings: Pick<SettingsStore, 'load'>;
  providers: Pick<ProvidersStore, 'load'>;
  asks: Pick<AskStreamStore, 'clear'>;
  updater: Updater;
  buildVersion: string;
  /**
   * `false` for a page that does not come from the server (the extension's
   * wall page): it cannot be the server's own build, so only the protocol
   * version must match. By default the build version must match too.
   */
  sameBuild?: boolean;
  setMeta(meta: Meta): void;
}

/** Identifies the server build a stale shell wants to become. */
const updateTarget = (meta: Meta): string => `${meta.version}/${meta.apiVersion}`;

export function createShell(deps: ShellDeps): Shell {
  const [phase, setPhase] = createSignal<ShellPhase>('loading');
  const [failure, setFailure] = createSignal<unknown>();
  const [updateAvailable, setUpdateAvailable] = createSignal(false);
  let latestMeta: Meta | undefined;
  /** Start-up sequences overlap when the user retries; only the newest may set the phase. */
  let run = 0;

  const isStale = (meta: Meta): boolean =>
    meta.apiVersion !== API_VERSION ||
    (deps.sameBuild !== false && meta.version !== deps.buildVersion);

  function fail(error: unknown): void {
    if (error instanceof ApiError && error.code === 'network') {
      setPhase('unreachable');
      return;
    }
    batch(() => {
      setFailure(error);
      setPhase('failed');
    });
  }

  async function loadData(ticket: number): Promise<void> {
    try {
      await Promise.all([deps.settings.load(), deps.providers.load()]);
    } catch (error) {
      if (ticket !== run) return;
      if (error instanceof ApiError && error.status === 401) setPhase('signed-out');
      else fail(error);
      return;
    }
    if (ticket === run) setPhase('ready');
  }

  async function start(): Promise<void> {
    const ticket = ++run;
    setPhase('loading');
    let meta: Meta;
    try {
      meta = await deps.api.getMeta();
    } catch (error) {
      if (ticket === run) fail(error);
      return;
    }
    if (ticket !== run) return;
    latestMeta = meta;
    deps.setMeta(meta);
    if (isStale(meta)) {
      setPhase('stale');
      await deps.updater.apply(updateTarget(meta));
      return;
    }
    deps.updater.settled();
    await loadData(ticket);
  }

  function signedOut(): void {
    const current = phase();
    // Before the shell is known to be current there is no session to lose.
    if (current === 'stale' || current === 'unreachable') return;
    run += 1;
    deps.asks.clear();
    setPhase('signed-out');
  }

  return {
    phase,
    failure,
    updateAvailable,
    start,
    signedOut,
    async signedIn() {
      const ticket = ++run;
      setPhase('loading');
      await loadData(ticket);
    },
    async logout() {
      await deps.api.logout();
      signedOut();
    },
    async checkVersion() {
      if (phase() !== 'ready') return;
      let meta: Meta;
      try {
        meta = await deps.api.getMeta();
      } catch {
        // Unreachable right now; the requests that matter report that themselves.
        return;
      }
      latestMeta = meta;
      if (isStale(meta)) setUpdateAvailable(true);
    },
    async applyUpdate() {
      const target = latestMeta ? updateTarget(latestMeta) : deps.buildVersion;
      await deps.updater.apply(target, true);
    },
  };
}
