/**
 * What the remote window's partition keeps, and for whom. There is one
 * partition for remote servers, so everything in it (the session cookie of
 * the pairing, storage, the service worker, the HTTP cache) must belong to
 * one server: the one whose origin is saved. Cookies are scoped by host, not
 * by port, and two ports of one host are the same site, so without this a
 * second service on the same host would be sent the first one's session.
 */

/** The parts of Electron's `Session` used here; tests pass a stand-in. */
export interface RemoteStore {
  /** Cookies, storage of every kind, service workers. */
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  /** HTTP authentication that was entered for a server. */
  clearAuthCache(): Promise<void>;
}

/**
 * Empties the partition unless it already belongs to `next`. Call it after
 * the previous server's window is gone and before anything of `next` is
 * loaded or saved; when it rejects, `next` must not be loaded.
 * @returns whether anything was cleared
 */
export async function claimRemoteStore(
  store: RemoteStore,
  previous: string | undefined,
  next: string,
): Promise<boolean> {
  if (previous === next) return false;
  await store.clearStorageData();
  await store.clearCache();
  await store.clearAuthCache();
  return true;
}
