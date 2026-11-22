import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Clock, Logger, TlsMaterial, TlsProvider } from '../contracts/index.ts';
import { validateMaterial } from './certificates.ts';

/** Renewal tools replace the certificate and the key one after the other; wait for both. */
export const RELOAD_DEBOUNCE_MS = 1_000;
/** Safety net for file systems that do not deliver change events (some network and container mounts). */
export const RECHECK_INTERVAL_MS = 60 * 60_000;

export interface CertFilesOptions {
  certFile: string;
  keyFile: string;
  logger: Logger;
  clock: Clock;
}

/**
 * `cert` mode: serves the PEM files the operator points to and picks up
 * renewals. A change is read after a short quiet period; if the new pair is
 * unreadable or does not match, the certificate in use stays in place.
 */
export function createCertFilesProvider(options: CertFilesOptions): TlsProvider {
  const { certFile, keyFile, logger, clock } = options;
  const listeners = new Set<(material: TlsMaterial) => void>();
  const watchers: FSWatcher[] = [];

  let current: TlsMaterial | undefined;
  let cancelDebounce: (() => void) | undefined;
  let cancelRecheck: (() => void) | undefined;
  let closed = false;

  const read = async (): Promise<TlsMaterial> => {
    const [cert, key] = await Promise.all([readFile(certFile, 'utf8'), readFile(keyFile, 'utf8')]);
    return validateMaterial(cert, key);
  };

  const reload = async (): Promise<void> => {
    let fresh: TlsMaterial;
    try {
      fresh = await read();
    } catch (error) {
      logger.warn('the changed certificate files cannot be used; keeping the current certificate', {
        // File-system errors carry paths in their message; their code is enough.
        reason:
          error instanceof Error && 'code' in error ? String(error.code) : (error as Error).message,
      });
      return;
    }
    if (closed || (fresh.cert === current?.cert && fresh.key === current.key)) return;
    current = fresh;
    logger.info('certificate reloaded');
    for (const listener of listeners) listener(fresh);
  };

  const scheduleReload = (): void => {
    if (closed) return;
    cancelDebounce?.();
    cancelDebounce = clock.schedule(RELOAD_DEBOUNCE_MS, () => void reload());
  };

  const scheduleRecheck = (): void => {
    if (closed) return;
    cancelRecheck = clock.schedule(RECHECK_INTERVAL_MS, () => {
      void reload().then(scheduleRecheck);
    });
  };

  const startWatching = (): void => {
    // Directories are watched, not the files: a renewal usually replaces the
    // file (or the symbolic link) instead of writing into it.
    const directories = new Set([dirname(resolve(certFile)), dirname(resolve(keyFile))]);
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, scheduleReload);
        watcher.on('error', () => {
          logger.warn('watching the certificate directory failed; relying on the hourly check');
        });
        watchers.push(watcher);
      } catch {
        logger.warn('the certificate directory cannot be watched; relying on the hourly check');
      }
    }
    scheduleRecheck();
  };

  return {
    mode: 'cert',
    async material() {
      if (!current) {
        try {
          current = await read();
        } catch (error) {
          const reason =
            error instanceof Error && 'code' in error
              ? `a file cannot be read (${String(error.code)})`
              : (error as Error).message;
          throw new Error(`The TLS certificate cannot be loaded: ${reason}`, { cause: error });
        }
        if (!closed) startWatching();
      }
      return current;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    caCertificatePem: async () => null,
    async close() {
      closed = true;
      cancelDebounce?.();
      cancelRecheck?.();
      for (const watcher of watchers.splice(0)) watcher.close();
      listeners.clear();
    },
  };
}
