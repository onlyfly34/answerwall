/**
 * The core host: what runs inside the utility process. It turns the start
 * message of the main process into an `AppConfig`, runs core's own server
 * with it, and stops it when told to. Nothing of core is re-implemented
 * here; the host only connects it to the utility process's message port.
 *
 * The launch token arrives in the start message and lives only in this
 * process's memory: it is never in the environment (which the CLI children
 * inherit) and never on a command line.
 */
import { AppError } from '@answerwall/core';
import type {
  AppConfig,
  ChildProcessTreeListener,
  Logger,
  SecretStore,
  ServerHandle,
  ServerOverrides,
} from '@answerwall/core';
import type { HostConfig, HostEvent, HostRequest } from '../shared/ipc.ts';
import type { ParentWatch } from './parent-watch.ts';

/** How long a shutdown may take before the host exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The utility process's side of the message port. */
export interface HostPort {
  postMessage(message: HostEvent): void;
  onMessage(listener: (message: unknown) => void): void;
}

/** The helper process that outlives the host; see `reaper.ts`. */
export interface Reaper {
  report: ChildProcessTreeListener;
}

export interface HostDeps {
  port: HostPort;
  createServer(config: AppConfig, overrides: ServerOverrides): Promise<ServerHandle>;
  logger: Logger;
  /** The environment the CLI children start from. */
  env: NodeJS.ProcessEnv;
  /** Reports child process trees for as long as the host lives. */
  watchChildren(listener: ChildProcessTreeListener): () => void;
  /** Kills every CLI tree at once; for exits that do not complete a shutdown. */
  killChildren(): void;
  startReaper(script: string): Reaper | undefined;
  /**
   * Calls `gone` once when the process that started this one no longer
   * exists. A utility process normally ends with the main process by itself;
   * where it does not (seen on Windows while children were running), it must
   * not stay behind holding the port and the data directory. The host tells
   * the watch of every message of the main process (`parent-watch.ts`).
   */
  watchParent(gone: () => void): ParentWatch;
  exit(code: number): void;
  schedule(ms: number, task: () => void): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The desktop configuration: loopback only, plain HTTP, the launch token as the only credential. */
export function desktopConfig(config: HostConfig): AppConfig {
  return {
    mode: 'desktop',
    version: config.version,
    host: '127.0.0.1',
    port: config.port,
    dataDir: config.dataDir,
    webRoot: config.webRoot,
    publicOrigins: [],
    trustedProxies: [],
    tls: { mode: 'off' },
    allowInsecure: false,
    staticToken: config.token,
    logLevel: config.logLevel,
  };
}

/**
 * A `SecretStore` whose values live in the main process (encrypted with the
 * operating system's key). Each call is one request over the message port.
 */
export function createBridgedSecretStore(port: Pick<HostPort, 'postMessage'>): {
  store: SecretStore;
  /** Feeds an answer from the main process back to the waiting call. */
  settle: (message: Extract<HostRequest, { type: 'secret-result' }>) => void;
} {
  let nextId = 1;
  const waiting = new Map<
    number,
    { resolve: (value: string | undefined) => void; reject: (error: Error) => void }
  >();

  const call = (
    request: { op: 'get' | 'delete'; key: string } | { op: 'set'; key: string; value: string },
  ): Promise<string | undefined> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      port.postMessage({ type: 'secret', id, ...request });
    });

  return {
    store: {
      get: (key) => call({ op: 'get', key }),
      async set(key, value) {
        await call({ op: 'set', key, value });
      },
      async delete(key) {
        await call({ op: 'delete', key });
      },
    },
    settle: (message) => {
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else if (message.reason === 'unavailable') {
        pending.reject(
          new AppError(
            'conflict',
            'This computer offers no encrypted storage for secrets, so the key was not saved',
          ),
        );
      } else pending.reject(new Error('The secret store failed'));
    },
  };
}

/** Connects the host to its message port. Returns after wiring; everything else is message-driven. */
export function runHost(deps: HostDeps): void {
  const { port, logger } = deps;
  const secrets = createBridgedSecretStore(port);
  let server: ServerHandle | undefined;
  let started = false;
  let stopping = false;

  async function start(config: HostConfig): Promise<void> {
    const reaper = deps.startReaper(config.reaper);
    if (reaper) deps.watchChildren(reaper.report);
    else logger.warn('the child process reaper could not be started');

    try {
      server = await deps.createServer(desktopConfig(config), {
        logger,
        secrets: secrets.store,
        env: deps.env,
      });
      const { port: bound } = await server.listen();
      port.postMessage({ type: 'listening', port: bound });
    } catch (error) {
      const inUse = isRecord(error) && error['code'] === 'EADDRINUSE';
      // Only the error's class: its message may contain paths.
      logger.error('the local server could not start', {
        error: error instanceof Error ? error.name : 'unknown',
        ...(inUse ? { reason: 'address in use' } : {}),
      });
      await server?.shutdown().catch(() => undefined);
      port.postMessage({ type: 'failed', reason: inUse ? 'address_in_use' : 'error' });
      deps.exit(1);
    }
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    const cancel = deps.schedule(SHUTDOWN_TIMEOUT_MS, () => {
      logger.error('shutdown timed out');
      deps.killChildren();
      deps.exit(1);
    });
    void (server?.shutdown() ?? Promise.resolve()).then(
      () => {
        cancel();
        deps.exit(0);
      },
      (error: unknown) => {
        cancel();
        logger.error('shutdown failed', { error: error instanceof Error ? error.name : 'unknown' });
        deps.killChildren();
        deps.exit(1);
      },
    );
  }

  const parent = deps.watchParent(() => {
    logger.error('the main process is gone; exiting');
    deps.killChildren();
    deps.exit(1);
  });

  port.onMessage((message) => {
    if (!isRecord(message)) return;
    // Whatever it says: the main process is there to say it.
    parent.heard();
    const request = message as HostRequest;
    switch (request.type) {
      case 'start':
        if (started) return;
        started = true;
        void start(request.config);
        return;
      case 'shutdown':
        stop();
        return;
      case 'secret-result':
        secrets.settle(request);
        return;
      default:
    }
  });
}
