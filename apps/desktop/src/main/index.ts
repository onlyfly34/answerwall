/**
 * The Electron main process: decides what the app shows (the connection
 * page, the local server's page or a remote server's page), owns the local
 * server's process and its launch token, and ends everything on the way out.
 *
 * Certificate errors are never bypassed: there is no `certificate-error`
 * handler, no custom verification and no command-line switch that relaxes
 * it. A server with a private CA works once that CA is installed in Windows.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { API_PATHS, API_VERSION } from '@answerwall/core/protocol';
import type { LoginTerminalResult } from '@answerwall/core/protocol';
import { APP } from '../shared/app-info.ts';
import { CHANNELS } from '../shared/ipc.ts';
import type {
  ApplyResult,
  ConnectionChoice,
  ConnectionMode,
  ConnectionProblem,
  ConnectionState,
  RemoteCheckResult,
  RemoteServerInfo,
} from '../shared/ipc.ts';
import { createTranslator, messagesFor, pickLanguage } from '../shared/messages/index.ts';
import type { Translate } from '../shared/messages/index.ts';
import { CoreStartError, startCore } from './core-process.ts';
import type { CoreProcessOptions, RunningCore } from './core-process.ts';
import { createDesktopSettingsStore } from './desktop-settings.ts';
import { createAppLog } from './log.ts';
import { openLoginTerminal } from './login-terminal.ts';
import type { Starter } from './login-terminal.ts';
import { menuTemplate } from './menu.ts';
import { allowsNavigation, isSameOrigin } from './navigation.ts';
import type { Confinement } from './navigation.ts';
import { classifyFetchFailure, PROBE_TIMEOUT_MS, probeRemote } from './remote-probe.ts';
import type { MetaFetch } from './remote-probe.ts';
import { createEncryptedSecretStore } from './secrets.ts';
import { createUpdater } from './updater.ts';
import type { Ask, UpdaterEngine } from './updater.ts';
import {
  createWindow,
  prepareConnectionSession,
  prepareLocalSession,
  prepareRemoteSession,
} from './windows.ts';

/** The bundle's own directory (`dist/`), inside the archive when packaged. */
const DIST = __dirname;
/** Files that other programs or processes open must be real files, outside the archive. */
const unpacked = (file: string): string =>
  file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const PATHS = {
  coreHost: path.join(DIST, 'core-host.cjs'),
  reaper: unpacked(path.join(DIST, 'reaper.cjs')),
  webRoot: unpacked(path.join(DIST, 'web')),
  licences: unpacked(path.join(DIST, 'licenses', 'THIRD-PARTY-LICENSES.txt')),
  localPreload: path.join(DIST, 'preload-local.cjs'),
  connectionPreload: path.join(DIST, 'preload-connection.cjs'),
  // A `file:` page has no access to the archive (the fuse that would grant it is off).
  connectionPage: unpacked(path.join(DIST, 'connection', 'index.html')),
  icon: path.join(DIST, 'icon.png'),
};

// Before anything asks for a path: the name decides where the user data lives.
app.setName(APP.name);
if (!app.commandLine.hasSwitch('user-data-dir')) {
  // A build that is not installed keeps its data apart from an installed one.
  const directory = app.isPackaged ? APP.name : `${APP.name}-dev`;
  app.setPath('userData', path.join(app.getPath('appData'), directory));
}
app.setAppUserModelId(APP.id);
// Every renderer is sandboxed, whatever a window's own preferences say.
app.enableSandbox();

const userData = app.getPath('userData');
const log = createAppLog(path.join(userData, 'logs'), { echo: !app.isPackaged });
const { logger } = log;
const settings = createDesktopSettingsStore(path.join(userData, 'desktop.json'));
const secrets = createEncryptedSecretStore({
  file: path.join(userData, 'secrets.json'),
  cipher: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  },
});

const connectionConfinement: Confinement = {
  kind: 'file',
  url: pathToFileURL(PATHS.connectionPage).href,
};

let t: Translate = createTranslator(messagesFor('en'));
let core: RunningCore | undefined;
/** The one window that shows a server's page; `core` is the local server it was opened for. */
let content: { window: BrowserWindow; mode: ConnectionMode; core?: RunningCore } | undefined;
let connection: BrowserWindow | undefined;
/** Why the connection page is showing, when it was not the user who opened it. */
let connectionProblem: ConnectionProblem | undefined;
let quitting = false;
let cleanedUp = false;

const frontWindow = (): BrowserWindow | undefined => connection ?? content?.window;

const ask: Ask = async (question) => {
  const options = {
    type: 'info' as const,
    title: APP.name,
    message: question.message,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    buttons: question.buttons,
    defaultId: 0,
    cancelId: question.buttons.length - 1,
    noLink: true,
  };
  const parent = frontWindow();
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response;
};

// --- The local server -------------------------------------------------------

const coreOptions: CoreProcessOptions = {
  fork: () => {
    const child = utilityProcess.fork(PATHS.coreHost, [], {
      serviceName: `${APP.name} local server`,
      stdio: 'pipe',
    });
    child.stdout?.on('data', (chunk: Buffer) => log.append(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => log.append(chunk.toString('utf8')));
    return child;
  },
  config: {
    version: app.getVersion(),
    dataDir: path.join(userData, 'data'),
    webRoot: PATHS.webRoot,
    logLevel: 'info',
    reaper: process.platform === 'win32' ? undefined : PATHS.reaper,
  },
  // 256 bits, new for every start of the local server.
  generateToken: () => randomBytes(32).toString('base64url'),
  secrets,
  logger,
  schedule(ms, task) {
    const timer = setTimeout(task, ms);
    return () => clearTimeout(timer);
  },
};

/** Whether `port` can be bound on loopback right now. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Brings the "check for updates" setting in line: it lives in the local
 * server's settings; the shell keeps a copy for when no local server runs.
 */
async function syncUpdateSetting(running: RunningCore): Promise<void> {
  const url = `${running.grant.origin}${API_PATHS.settings}`;
  const headers = { accept: 'application/json', authorization: `Bearer ${running.grant.token}` };
  try {
    const stored = settings.get();
    if (stored.updateCheckPending) {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ updateCheck: stored.updateCheck }),
      });
      if (response.ok) settings.update({ updateCheckPending: false });
      return;
    }
    const response = await fetch(url, { headers });
    const body = (await response.json()) as { settings?: { updateCheck?: unknown } };
    if (typeof body.settings?.updateCheck === 'boolean') {
      settings.update({ updateCheck: body.settings.updateCheck });
    }
  } catch {
    logger.warn('the update setting could not be read from the local server');
  }
}

async function ensureCore(): Promise<RunningCore> {
  if (core) return core;
  const remembered = settings.get().localPort;
  const port = remembered !== undefined && (await isFree(remembered)) ? remembered : 0;
  let running: RunningCore;
  try {
    running = await startCore(coreOptions, port);
  } catch (error) {
    const taken = error instanceof CoreStartError && error.reason === 'address_in_use';
    if (!taken || port === 0) throw error;
    // Someone took the port between the check and the start.
    running = await startCore(coreOptions, 0);
  }
  core = running;
  settings.update({ localPort: running.port });
  void running.exited.then((unexpected) => {
    if (core === running) core = undefined;
    if (unexpected && !quitting) void coreCrashed();
  });
  await syncUpdateSetting(running);
  return running;
}

async function stopCore(): Promise<void> {
  const running = core;
  core = undefined;
  await running?.stop();
}

async function coreCrashed(): Promise<void> {
  logger.error('the local server stopped unexpectedly');
  if (content?.mode !== 'local') return;
  const choice = await ask({
    message: t('core.crashed'),
    detail: t('core.crashed.detail'),
    buttons: [t('core.restart'), t('menu.connection'), t('button.quit')],
  });
  if (choice === 0) {
    try {
      await openLocal();
    } catch {
      showConnection({ kind: 'local_failed' });
    }
  } else if (choice === 1) showConnection(undefined);
  else app.quit();
}

// --- Windows ----------------------------------------------------------------

function watch(window: BrowserWindow): void {
  // Windows is logging off or shutting down: there is no time to wait for anything.
  window.on('session-end', () => core?.requestStop());
}

/** Makes `window` the one content window; the previous one goes away. */
function replaceContent(window: BrowserWindow, mode: ConnectionMode, running?: RunningCore): void {
  const previous = content?.window;
  content = { window, mode, ...(running ? { core: running } : {}) };
  window.on('closed', () => {
    if (content?.window === window) content = undefined;
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitting || details.reason === 'clean-exit' || window.isDestroyed()) return;
    logger.error('a window process is gone', { reason: details.reason });
    void ask({
      message: t('window.crashed'),
      buttons: [t('window.reload'), t('button.quit')],
    }).then((choice) => {
      if (choice !== 0) app.quit();
      else if (!window.isDestroyed()) window.webContents.reload();
    });
  });
  watch(window);
  if (previous && !previous.isDestroyed()) previous.destroy();
}

async function openLocal(): Promise<void> {
  const running = await ensureCore();
  // A window of an earlier start of the local server has the wrong address and token.
  if (content?.core === running && !content.window.isDestroyed()) {
    content.window.focus();
    return;
  }
  const window = createWindow({
    session: prepareLocalSession(running.grant),
    confinement: { kind: 'origin', origin: running.grant.origin },
    preload: PATHS.localPreload,
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: APP.name,
    icon: PATHS.icon,
    devTools: !app.isPackaged,
  });
  replaceContent(window, 'local', running);
  await window.loadURL(`${running.grant.origin}/`);
}

async function openRemote(server: RemoteServerInfo): Promise<void> {
  const window = createWindow({
    session: prepareRemoteSession(server.origin),
    confinement: { kind: 'origin', origin: server.origin },
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: APP.name,
    icon: PATHS.icon,
    devTools: !app.isPackaged,
  });
  if (server.insecure) {
    // Plain HTTP stays visible for as long as the window is open.
    const mark = (title: string): void =>
      window.setTitle(`${title} (${t('title.insecure')}: ${server.origin})`);
    window.on('page-title-updated', (event, title) => {
      event.preventDefault();
      mark(title);
    });
    mark(APP.name);
  }
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3: the load was aborted, which a navigation the app itself refused also is.
    if (!isMainFrame || code === -3 || quitting) return;
    logger.warn('the remote server could not be loaded', { code });
    showConnection(classifyFetchFailure({ error: description, timedOut: false }));
  });
  replaceContent(window, 'remote');
  try {
    await window.loadURL(`${server.origin}/`);
  } catch {
    // Reported by `did-fail-load` above.
  }
}

function showConnection(problem: ConnectionProblem | undefined): void {
  connectionProblem = problem;
  if (connection && !connection.isDestroyed()) {
    connection.webContents.reload();
    connection.focus();
    return;
  }
  const parent = content?.window;
  const window = createWindow({
    session: prepareConnectionSession(),
    confinement: connectionConfinement,
    preload: PATHS.connectionPreload,
    width: 620,
    height: 720,
    minWidth: 420,
    minHeight: 520,
    title: `${APP.name}: ${t('connection.title')}`,
    icon: PATHS.icon,
    devTools: !app.isPackaged,
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
  });
  connection = window;
  window.on('closed', () => {
    if (connection === window) connection = undefined;
  });
  watch(window);
  void window.loadFile(PATHS.connectionPage);
}

// --- Remote servers ---------------------------------------------------------

async function fetchMeta(url: string): Promise<MetaFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Chromium's network stack, as the window will use it: the same trust store, the same proxy.
    const response = await session.fromPartition(APP.partitions.remote).fetch(url, {
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    return { ok: true, status: response.status, body: await response.text() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

const checkRemote = (url: string): Promise<RemoteCheckResult> =>
  probeRemote(url, {
    resolve: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
    fetchMeta,
    appVersion: app.getVersion(),
  });

async function applyChoice(choice: ConnectionChoice): Promise<ApplyResult> {
  if (choice.mode === 'local') {
    try {
      await openLocal();
    } catch (error) {
      logger.error('local mode could not be opened', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { ok: false, problem: { kind: 'local_failed' } };
    }
    settings.update({ mode: 'local' });
  } else {
    const checked = await checkRemote(choice.url);
    if (!checked.ok) return checked;
    settings.update({ mode: 'remote', remoteUrl: checked.server.origin });
    await openRemote(checked.server);
    // Nothing uses the local server now; its CLI children end with it.
    await stopCore();
  }
  connectionProblem = undefined;
  connection?.close();
  return { ok: true };
}

// --- Pages talking to the main process --------------------------------------

function fromConnectionPage(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    connection !== undefined &&
    !connection.isDestroyed() &&
    event.sender === connection.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    allowsNavigation(frame.url, connectionConfinement)
  );
}

function fromLocalPage(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    core !== undefined &&
    content?.mode === 'local' &&
    !content.window.isDestroyed() &&
    event.sender === content.window.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    isSameOrigin(frame.url, core.grant.origin)
  );
}

const startDetached: Starter = (launch) =>
  new Promise((resolve) => {
    try {
      const child = spawn(launch.file, launch.args, {
        cwd: homedir(),
        // The user's own environment. The launch token is not in it.
        env: process.env,
        stdio: 'ignore',
        shell: false,
        detached: process.platform !== 'win32',
        // The outer `cmd` only starts the visible one.
        windowsHide: launch.verbatim === true,
        windowsVerbatimArguments: launch.verbatim === true,
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

function registerIpc(updatesSupported: boolean): void {
  const language = pickLanguage(app.getLocale());

  ipcMain.handle(CHANNELS.connectionState, (event): ConnectionState => {
    if (!fromConnectionPage(event)) throw new Error('forbidden');
    const stored = settings.get();
    return {
      language,
      messages: messagesFor(language),
      appVersion: app.getVersion(),
      apiVersion: API_VERSION,
      mode: stored.mode,
      remoteUrl: stored.remoteUrl ?? '',
      updateCheck: stored.updateCheck,
      updatesSupported,
      problem: connectionProblem,
    };
  });

  ipcMain.handle(CHANNELS.connectionCheck, (event, url: unknown): Promise<RemoteCheckResult> => {
    if (!fromConnectionPage(event)) throw new Error('forbidden');
    return checkRemote(typeof url === 'string' ? url.slice(0, 2048) : '');
  });

  ipcMain.handle(CHANNELS.connectionApply, (event, choice: unknown): Promise<ApplyResult> => {
    if (!fromConnectionPage(event)) throw new Error('forbidden');
    const request = choice as { mode?: unknown; url?: unknown } | null;
    if (request?.mode === 'local') return applyChoice({ mode: 'local' });
    if (request?.mode === 'remote' && typeof request.url === 'string') {
      return applyChoice({ mode: 'remote', url: request.url.slice(0, 2048) });
    }
    throw new Error('bad request');
  });

  ipcMain.handle(CHANNELS.connectionSetUpdateCheck, async (event, enabled: unknown) => {
    if (!fromConnectionPage(event)) throw new Error('forbidden');
    if (typeof enabled !== 'boolean') throw new Error('bad request');
    settings.update({ updateCheck: enabled, updateCheckPending: true });
    if (core) await syncUpdateSetting(core);
  });

  ipcMain.handle(
    CHANNELS.openLoginTerminal,
    (event, kind: unknown): Promise<LoginTerminalResult> => {
      if (!fromLocalPage(event)) throw new Error('forbidden');
      return openLoginTerminal(kind, {
        platform: process.platform,
        title: t('terminal.title', { name: APP.name }),
        env: process.env,
        start: startDetached,
      });
    },
  );
}

// --- Start and end ----------------------------------------------------------

async function openSavedChoice(): Promise<void> {
  const stored = settings.get();
  if (stored.mode === 'local') {
    try {
      await openLocal();
    } catch (error) {
      logger.error('local mode could not be opened', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      showConnection({ kind: 'local_failed' });
    }
  } else if (stored.mode === 'remote' && stored.remoteUrl !== undefined) {
    const checked = await checkRemote(stored.remoteUrl);
    if (checked.ok) await openRemote(checked.server);
    else showConnection(checked.problem);
  } else showConnection(undefined);
}

async function main(): Promise<void> {
  await app.whenReady();
  t = createTranslator(messagesFor(pickLanguage(app.getLocale())));
  logger.info('starting', { version: app.getVersion(), packaged: app.isPackaged });

  const updater = createUpdater({
    // Loaded on demand: reading `autoUpdater` creates the platform's updater.
    engine: async (): Promise<UpdaterEngine> => (await import('electron-updater')).autoUpdater,
    supported: app.isPackaged && process.platform === 'win32',
    disabledByEnvironment: process.env[APP.env.updates]?.trim().toLowerCase() === 'off',
    currentVersion: app.getVersion(),
    t,
    ask,
    logger,
    // The quit that follows finds nothing left to stop.
    prepareToInstall: () => shutdown(),
  });

  // Linux and macOS: the system is shutting down.
  powerMonitor.on('shutdown', () => app.quit());

  registerIpc(updater.available);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(
        t,
        {
          openConnection: () => showConnection(undefined),
          checkForUpdates: () => void updater.checkFromMenu(),
          about: () =>
            void ask({
              message: APP.name,
              detail: t('about.detail', {
                version: app.getVersion(),
                electron: process.versions.electron,
                chrome: process.versions.chrome,
                node: process.versions.node,
                repository: APP.repository.url,
              }),
              buttons: [t('button.ok')],
            }),
          licences: () => void shell.openPath(PATHS.licences),
          openLogs: () => void shell.openPath(log.directory),
          quit: () => app.quit(),
        },
        { devTools: !app.isPackaged },
      ),
    ),
  );

  await openSavedChoice();
  // The setting was just read from the local server, or is the copy kept for remote mode.
  if (settings.get().updateCheck) void updater.checkQuietly();
}

/** Stops the local server and, with it, every CLI child. Safe to call more than once. */
async function shutdown(): Promise<void> {
  quitting = true;
  try {
    await stopCore();
  } catch {
    // The helper process of the core host ends its children in any case.
  }
  try {
    // The remote server's session cookie is written with a delay; do not lose a fresh pairing.
    if (app.isReady()) await session.fromPartition(APP.partitions.remote).cookies.flushStore();
  } catch {
    // Nothing to flush.
  }
  cleanedUp = true;
}

function fatal(error: unknown): void {
  logger.error('the shell crashed', { error: error instanceof Error ? error.name : 'unknown' });
  core?.requestStop();
  if (app.isReady()) {
    dialog.showErrorBox(
      t('fatal.title', { name: APP.name }),
      t('fatal.detail', { logs: log.directory }),
    );
  }
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', {
      error: reason instanceof Error ? reason.name : 'unknown',
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => app.quit());
  }

  app.on('second-instance', () => {
    const window = frontWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  // Nothing but the windows made in `windows.ts` exists; anything else stays inert.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    void shutdown().finally(() => app.quit());
  });

  main().catch(fatal);
}
