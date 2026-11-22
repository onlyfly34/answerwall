/**
 * Window and session hardening. Every window is created here, with the same
 * locked-down web preferences, confined to the one place it is for.
 */
import { BrowserWindow, session, shell } from 'electron';
import type { Session, WebContents } from 'electron';
import { APP } from '../shared/app-info.ts';
import { authorizedHeaders } from './auth-header.ts';
import type { LocalGrant } from './auth-header.ts';
import {
  allowsLocalRequest,
  allowsNavigation,
  isSameOrigin,
  windowOpenAction,
} from './navigation.ts';
import type { Confinement } from './navigation.ts';
import { lockedWebPreferences } from './web-preferences.ts';

/** The one permission a page gets: writing text to the clipboard, for the copy buttons. */
const CLIPBOARD_WRITE = 'clipboard-sanitized-write';

/**
 * Denies every permission in `ses` except clipboard writes by `origin`.
 * Without an origin (the connection page) everything is denied.
 */
export function restrictPermissions(ses: Session, origin: string | undefined): void {
  const allowed = (permission: string, requester: string | undefined): boolean =>
    origin !== undefined &&
    permission === CLIPBOARD_WRITE &&
    requester !== undefined &&
    isSameOrigin(requester, origin);

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowed(permission, details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin),
  );
  ses.setDevicePermissionHandler(() => false);
  // No handler: every screen capture request is refused.
  ses.setDisplayMediaRequestHandler(null);
}

/**
 * Prepares the local window's session for one launch of the local server:
 * the launch token is added to requests for the server's exact origin, and
 * requests to anywhere else do not leave at all.
 */
export function prepareLocalSession(grant: LocalGrant): Session {
  const ses = session.fromPartition(APP.partitions.local);
  restrictPermissions(ses, grant.origin);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowsLocalRequest(details.url, grant.origin) });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: authorizedHeaders(details.url, details.requestHeaders, grant) });
  });
  return ses;
}

export function prepareRemoteSession(origin: string): Session {
  const ses = session.fromPartition(APP.partitions.remote);
  restrictPermissions(ses, origin);
  return ses;
}

export function prepareConnectionSession(): Session {
  const ses = session.fromPartition(APP.partitions.connection);
  restrictPermissions(ses, undefined);
  // The page is one bundled file with its script and style; it requests nothing else.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/i.test(details.url) });
  });
  return ses;
}

/** Keeps `contents` where it belongs; see `navigation.ts` for the rules. */
export function confine(contents: WebContents, confinement: Confinement): void {
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (!allowsNavigation(url, confinement)) event.preventDefault();
  };
  contents.on('will-navigate', (event, url) => guard(event, url));
  contents.on('will-frame-navigate', (event) => guard(event, event.url));
  contents.on('will-redirect', (event, url) => guard(event, url));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (windowOpenAction(url, confinement) === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export interface WindowOptions {
  session: Session;
  confinement: Confinement;
  /** A sandboxed preload script; most windows have none. */
  preload?: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  title: string;
  icon?: string;
  devTools: boolean;
  parent?: BrowserWindow;
}

export function createWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    ...(options.minWidth === undefined ? {} : { minWidth: options.minWidth }),
    ...(options.minHeight === undefined ? {} : { minHeight: options.minHeight }),
    title: options.title,
    show: false,
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    webPreferences: lockedWebPreferences(options),
  });
  confine(window.webContents, options.confinement);
  window.once('ready-to-show', () => window.show());
  return window;
}
