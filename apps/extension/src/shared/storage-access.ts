/**
 * Who may read the extension's storage. By default Chromium also exposes
 * `chrome.storage.local` to content scripts, which run inside the renderer
 * of a web page. The server's address and the device token are needed by the
 * wall page only, so the storage is closed to everything but the extension's
 * own pages and its service worker.
 */
export const STORAGE_ACCESS_LEVEL = 'TRUSTED_CONTEXTS';

/**
 * Closes the storage to content scripts. The browser keeps the level, but it
 * is set again by the service worker whenever it starts and by the wall page
 * before it reads or writes anything. `false` when the browser refused.
 */
export async function restrictStorage(
  area: Pick<chrome.storage.StorageArea, 'setAccessLevel'>,
): Promise<boolean> {
  try {
    await area.setAccessLevel({ accessLevel: STORAGE_ACCESS_LEVEL });
    return true;
  } catch {
    return false;
  }
}
