/**
 * The main process's handle on the local server: starts the core host in a
 * utility process, hands it the launch token over the process's message
 * port, answers its secret store requests, and stops it.
 */
import type { Logger } from '@answerwall/core';
import type { HostConfig, HostEvent, HostRequest } from '../shared/ipc.ts';
import type { LocalGrant } from './auth-header.ts';
import { SecretsUnavailableError } from './secrets.ts';
import type { EncryptedSecretStore } from './secrets.ts';

/** How long the host may take to report that it listens. */
export const START_TIMEOUT_MS = 30_000;
/** How long a graceful stop may take; the host's own limit is shorter. */
export const STOP_TIMEOUT_MS = 12_000;

/** The parts of Electron's `UtilityProcess` used here; tests pass a stand-in. */
export interface HostProcess {
  postMessage(message: HostRequest): void;
  kill(): boolean;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'message', listener: (message: HostEvent) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface CoreProcessOptions {
  fork(): HostProcess;
  /** Everything but the token and the port, which belong to one start. */
  config: Omit<HostConfig, 'token' | 'port'>;
  /** A fresh random token; called once per start. */
  generateToken(): string;
  secrets: EncryptedSecretStore;
  logger: Logger;
  schedule(ms: number, task: () => void): () => void;
}

export interface RunningCore {
  grant: LocalGrant;
  port: number;
  /** Resolves when the host has exited; `true` when nobody asked it to. */
  exited: Promise<boolean>;
  /** Asks the host to shut down without waiting (the session is ending). */
  requestStop(): void;
  /** Shuts the host down and waits; kills it when it does not finish in time. */
  stop(): Promise<void>;
}

export class CoreStartError extends Error {
  readonly reason: 'address_in_use' | 'error' | 'timeout' | 'exited';

  constructor(reason: CoreStartError['reason']) {
    super(`The local server did not start (${reason})`);
    this.name = 'CoreStartError';
    this.reason = reason;
  }
}

async function answerSecret(
  secrets: EncryptedSecretStore,
  request: Extract<HostEvent, { type: 'secret' }>,
): Promise<HostRequest> {
  const { id } = request;
  try {
    if (request.op === 'get') {
      const value = await secrets.get(request.key);
      return { type: 'secret-result', id, ok: true, ...(value === undefined ? {} : { value }) };
    }
    if (request.op === 'set') await secrets.set(request.key, request.value);
    else await secrets.delete(request.key);
    return { type: 'secret-result', id, ok: true };
  } catch (error) {
    const reason = error instanceof SecretsUnavailableError ? 'unavailable' : 'error';
    return { type: 'secret-result', id, ok: false, reason };
  }
}

/**
 * Starts the host on `port` (0 lets the system choose) and resolves once it
 * listens.
 * @throws CoreStartError
 */
export function startCore(options: CoreProcessOptions, port: number): Promise<RunningCore> {
  const { logger, secrets } = options;
  const token = options.generateToken();
  const child = options.fork();

  let stopRequested = false;
  let exitedFlag = false;
  let resolveExited: (unexpected: boolean) => void = () => undefined;
  const exited = new Promise<boolean>((resolve) => {
    resolveExited = resolve;
  });

  const requestStop = (): void => {
    if (stopRequested || exitedFlag) return;
    stopRequested = true;
    child.postMessage({ type: 'shutdown' });
  };

  const stop = async (): Promise<void> => {
    if (exitedFlag) return;
    requestStop();
    const cancel = options.schedule(STOP_TIMEOUT_MS, () => {
      logger.error('the local server did not stop in time and is killed');
      child.kill();
    });
    await exited;
    cancel();
  };

  return new Promise<RunningCore>((resolve, reject) => {
    let settled = false;
    const fail = (reason: CoreStartError['reason']): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      reject(new CoreStartError(reason));
    };
    const cancelTimeout = options.schedule(START_TIMEOUT_MS, () => {
      fail('timeout');
      child.kill();
    });

    child.on('spawn', () => {
      child.postMessage({ type: 'start', config: { ...options.config, token, port } });
    });

    child.on('message', (message) => {
      switch (message.type) {
        case 'listening': {
          if (settled) return;
          settled = true;
          cancelTimeout();
          const origin = `http://127.0.0.1:${message.port}`;
          logger.info('the local server is listening', { port: message.port });
          resolve({ grant: { origin, token }, port: message.port, exited, requestStop, stop });
          return;
        }
        case 'failed':
          fail(message.reason);
          return;
        case 'secret':
          void answerSecret(secrets, message).then((answer) => {
            if (!exitedFlag) child.postMessage(answer);
          });
          return;
        default:
      }
    });

    child.on('exit', (code) => {
      exitedFlag = true;
      logger.info('the local server exited', { code });
      fail('exited');
      resolveExited(!stopRequested);
    });
  });
}
