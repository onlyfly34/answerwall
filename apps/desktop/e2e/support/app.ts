/**
 * Starts the desktop app for a test: the built app under the Electron of
 * `node_modules`, or a packaged executable (`E2E_APP_EXECUTABLE`), with its
 * own user data directory and the sandbox environment of the server suite,
 * whose `PATH` holds the mock CLIs and Node and nothing else. No real CLI
 * can be started from these tests.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { ROOT, runDir, sandboxEnv } from '../../../../e2e/support/environment.ts';
import { readMockLog, until } from '../../../../e2e/support/server.ts';
import type { MockInvocation } from '../../../../e2e/support/server.ts';
import {
  recordedProcesses,
  runningProcesses,
} from '../../../../tools/mock-clis/src/lib/leftovers.mjs';
import { killTree, processesMentioning } from './processes.ts';
import type { ProcessInfo } from './processes.ts';

export const APP_DIR = path.join(ROOT, 'apps', 'desktop');
export const APP_MAIN = path.join(APP_DIR, 'dist', 'main.cjs');
/** Set to test an installed or unpacked build instead of the sources' own `dist/`. */
export const PACKAGED_EXECUTABLE = process.env['E2E_APP_EXECUTABLE'] || undefined;

/**
 * Linux only: no display is needed, and the Chromium sandbox is off, because
 * neither a CI runner nor a development container lets an unprivileged
 * process create the namespaces it needs. Windows runs the app as shipped.
 */
const LINUX_ARGS = ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu'];

function electronBinary(): string {
  // In Node, the package's export is the path of the downloaded binary.
  const binary: unknown = createRequire(import.meta.url)('electron');
  if (typeof binary !== 'string') throw new Error('The electron package did not give a path');
  return binary;
}

/** The directories of one imagined user; survives restarts of the app within a test. */
export interface Profile {
  dir: string;
  userData: string;
  home: string;
  mockLog: string;
  /** Writes the shell's settings file, as an earlier run of the app would have left it. */
  seed(settings: Record<string, unknown>): Promise<void>;
  /** The shell's settings file as it is now. */
  settings(): Promise<Record<string, unknown>>;
}

export async function createProfile(): Promise<Profile> {
  const dir = await mkdtemp(path.join(runDir(), 'desktop-'));
  const userData = path.join(dir, 'user-data');
  const home = path.join(dir, 'home');
  await mkdir(userData);
  // The directories the environment of the app points at (see `launchEnv`).
  for (const sub of ['.config', 'AppData/Roaming', 'AppData/Local']) {
    await mkdir(path.join(home, sub), { recursive: true });
  }
  const file = path.join(userData, 'desktop.json');
  return {
    dir,
    userData,
    home,
    mockLog: path.join(dir, 'mock-invocations.jsonl'),
    seed: (settings) => writeFile(file, JSON.stringify({ version: 1, ...settings })),
    settings: async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>,
  };
}

export async function removeProfile(profile: Profile): Promise<void> {
  await rm(profile.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export interface LaunchOptions {
  /** Extra environment, for example `MOCK_CLI_SCENARIO`. */
  env?: Record<string, string>;
  /** Milliseconds between the lines of a mock's `slow` scenario. */
  mockDelayMs?: number;
  /** Extra command-line switches for Chromium. */
  args?: string[];
}

export interface DesktopApp {
  electron: ElectronApplication;
  profile: Profile;
  /** The process id of the main process. */
  pid: number;
  /** The window that shows a server's page (local or remote), once it has one. */
  contentWindow(): Promise<Page>;
  /** The bundled connection page, once it is open. */
  connectionWindow(): Promise<Page>;
  /** Chooses an item of the application menu, by its position, as a click would. */
  clickMenu(menu: number, item: number): Promise<void>;
  mockInvocations(): MockInvocation[];
  /** Process ids of mock CLIs (and their children) that are still running. */
  liveMockPids(): Promise<number[]>;
  /** Every process that belongs to this app: they all carry the user data directory. */
  processes(): Promise<ProcessInfo[]>;
  /** Quits as the user would, and waits for the main process to end. */
  quit(): Promise<void>;
  /** What the app wrote to its log file. */
  log(): Promise<string>;
}

export function launchArgs(
  profile: Profile,
  extra: string[] = [],
): { executablePath: string; args: string[] } {
  return {
    executablePath: PACKAGED_EXECUTABLE ?? electronBinary(),
    args: [
      ...(PACKAGED_EXECUTABLE === undefined ? [APP_DIR] : []),
      `--user-data-dir=${profile.userData}`,
      '--lang=en-US',
      ...(process.platform === 'linux' ? LINUX_ARGS : []),
      ...extra,
    ],
  };
}

export function launchEnv(profile: Profile, options: LaunchOptions = {}): Record<string, string> {
  const appData = path.join(profile.home, 'AppData');
  return sandboxEnv({
    mocks: 'all',
    home: profile.home,
    extra: {
      MOCK_CLI_LOG: profile.mockLog,
      MOCK_CLI_DELAY_MS: String(options.mockDelayMs ?? 120),
      // No request leaves the machine: the tests never ask GitHub for a release.
      ANSWERWALL_DESKTOP_UPDATES: 'off',
      // Everything the app could look up in the user's profile points into the test's own.
      APPDATA: path.join(appData, 'Roaming'),
      LOCALAPPDATA: path.join(appData, 'Local'),
      XDG_CONFIG_HOME: path.join(profile.home, '.config'),
      ...options.env,
    },
  });
}

const isConnectionPage = (page: Page): boolean =>
  /^file:.*\/connection\/index\.html/.test(page.url());
const isContentPage = (page: Page): boolean => /^https?:/.test(page.url());

export async function launchDesktop(
  profile: Profile,
  options: LaunchOptions = {},
): Promise<DesktopApp> {
  const app = await electron.launch({
    ...launchArgs(profile, options.args),
    env: launchEnv(profile, options),
    cwd: profile.dir,
    timeout: 60_000,
  });
  // Asked of the main process itself: on Windows the process the test driver
  // started is a shell around it.
  const pid = await app.evaluate(() => process.pid);

  let closed = false;
  app.on('close', () => {
    closed = true;
  });

  const find = (what: string, matches: (page: Page) => boolean): Promise<Page> =>
    until(what, () => app.windows().find((page) => !page.isClosed() && matches(page)), 60_000);

  return {
    electron: app,
    profile,
    pid,
    async contentWindow() {
      const page = await find('the content window', isContentPage);
      await page.waitForLoadState('domcontentloaded');
      return page;
    },
    async connectionWindow() {
      const page = await find('the connection window', isConnectionPage);
      await page.waitForLoadState('domcontentloaded');
      return page;
    },
    async clickMenu(menu, item) {
      await app.evaluate(
        ({ Menu, BrowserWindow }, [menuIndex, itemIndex]) => {
          const entry =
            Menu.getApplicationMenu()?.items[menuIndex ?? 0]?.submenu?.items[itemIndex ?? 0];
          if (!entry) throw new Error('No such menu item');
          const click = entry.click as (...args: unknown[]) => void;
          click(undefined, BrowserWindow.getFocusedWindow() ?? undefined, undefined);
        },
        [menu, item] as const,
      );
    },
    mockInvocations: () => readMockLog(profile.mockLog),
    liveMockPids: () => runningProcesses(recordedProcesses(profile.mockLog)),
    processes: () => processesMentioning(profile.userData),
    async quit() {
      if (closed) return;
      const ended = app.waitForEvent('close', { timeout: 60_000 });
      await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
      await ended;
    },
    log: () => readFile(path.join(profile.userData, 'logs', 'desktop.log'), 'utf8').catch(() => ''),
  };
}

/** Whatever of the app is still running is ended; returns what had to be. */
export async function sweep(profile: Profile): Promise<string[]> {
  const left: string[] = [];
  const survivors = [
    ...(await processesMentioning(profile.userData)),
    // The helper of the core host carries only its script's name. One app runs at a time.
    ...(await processesMentioning('reaper.cjs')),
  ];
  for (const survivor of survivors) {
    const kind = /--type=([\w-]+)/.exec(survivor.commandLine)?.[1] ?? 'main or helper';
    left.push(`app process ${survivor.pid} (${kind})`);
    await killTree(survivor.pid);
  }
  for (const pid of await runningProcesses(recordedProcesses(profile.mockLog))) {
    left.push(`mock CLI ${pid}`);
    await killTree(pid);
  }
  return left;
}
