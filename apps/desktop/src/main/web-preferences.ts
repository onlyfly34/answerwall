import type { Session, WebPreferences } from 'electron';

/**
 * The web preferences of every window; nothing else in the app sets any.
 * Context isolation and the sandbox are on, Node is nowhere in a renderer,
 * and there is no `<webview>`. (Electron's `remote` module no longer exists.)
 */
export function lockedWebPreferences(options: {
  session: Session;
  /** A sandboxed preload script; most windows have none. */
  preload?: string | undefined;
  devTools: boolean;
}): WebPreferences {
  return {
    session: options.session,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    // The spell checker downloads its dictionaries from a third party.
    spellcheck: false,
    devTools: options.devTools,
    ...(options.preload === undefined ? {} : { preload: options.preload }),
  };
}
