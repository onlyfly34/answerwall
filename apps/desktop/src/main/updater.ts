/**
 * Updates. The only source is the GitHub Releases of this repository. A
 * check happens at start when the setting allows it, or from the menu.
 * Nothing is downloaded and nothing is installed without the user saying so
 * in a dialog each time; nothing happens silently, and nothing on quit.
 *
 * The installer is not code-signed, so there is no publisher to verify:
 * electron-updater checks the download against the SHA-512 in `latest.yml`,
 * which it fetched over HTTPS from the same release. The build states this
 * explicitly (`verifyUpdateCodeSignature: false`); see docs/desktop.md.
 */
import type { Logger } from '@answerwall/core';
import { APP } from '../shared/app-info.ts';
import type { Translate } from '../shared/messages/index.ts';

/** The parts of electron-updater's `autoUpdater` used here. */
export interface UpdaterEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  logger: unknown;
  setFeedURL(options: { provider: 'github'; owner: string; repo: string }): void;
  /** Resolves with `null` when the updater is inactive. */
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean;
    updateInfo: { version: string };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export type Ask = (question: {
  message: string;
  detail?: string;
  /** The first button is the default, the last the way out. */
  buttons: string[];
}) => Promise<number>;

export interface UpdaterOptions {
  /** Loaded on first use: the module creates the platform's updater when it is read. */
  engine(): Promise<UpdaterEngine>;
  /** `false` for builds that cannot update themselves (unpackaged, not Windows). */
  supported: boolean;
  /** Switched off from outside (`<PREFIX>DESKTOP_UPDATES=off`). */
  disabledByEnvironment: boolean;
  currentVersion: string;
  t: Translate;
  ask: Ask;
  logger: Logger;
  /** Stops the local server and whatever else must end before the installer runs. */
  prepareToInstall(): Promise<void>;
  /**
   * Undoes {@link prepareToInstall} when the installation did not happen
   * after all: the app is still running and must be usable again.
   */
  resumeAfterFailedInstall(): Promise<void>;
  /** Whether the app has begun to quit, which a started installation makes it do. */
  quitStarted(): boolean;
  schedule(ms: number, task: () => void): () => void;
}

/**
 * How long after the installation was started the app may still be running
 * without having begun to quit. `quitAndInstall` quits on the next turn of
 * the event loop when the installer started, and only returns when it did not.
 */
export const INSTALL_GRACE_MS = 5_000;

export interface Updater {
  readonly available: boolean;
  /** The check at start: says nothing unless there is an update. */
  checkQuietly(): Promise<void>;
  /** The check from the menu: always answers. */
  checkFromMenu(): Promise<void>;
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { t, ask, logger } = options;
  const available = options.supported && !options.disabledByEnvironment;
  let engine: UpdaterEngine | undefined;
  let busy = false;

  const configured = async (): Promise<UpdaterEngine> => {
    if (engine) return engine;
    engine = await options.engine();
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.autoRunAppAfterInstall = true;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.disableWebInstaller = true;
    engine.logger = {
      info: (message: unknown) => logger.info('updater', { detail: String(message) }),
      warn: (message: unknown) => logger.warn('updater', { detail: String(message) }),
      error: (message: unknown) => logger.error('updater', { detail: String(message) }),
      debug: () => undefined,
    };
    // Stated in code as well as in the packaged configuration: this repository and no other.
    engine.setFeedURL({
      provider: 'github',
      owner: APP.repository.owner,
      repo: APP.repository.name,
    });
    return engine;
  };

  /**
   * The installation the user agreed to. From `prepareToInstall` on, the
   * local server is stopped and the app counts as quitting; when the
   * installer then does not take over (it threw, or it returned without
   * making the app quit: a missing or locked file, a failed start), the app
   * is brought back instead of being left open and unusable.
   */
  async function installNow(updater: UpdaterEngine): Promise<void> {
    let resumed = false;
    const resume = async (reason: string): Promise<void> => {
      if (resumed) return;
      resumed = true;
      logger.warn('the update was not installed', { reason });
      try {
        await options.resumeAfterFailedInstall();
      } catch (error) {
        logger.error('the app could not be resumed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
      await ask({
        message: t('update.installFailed'),
        detail: t('update.installFailed.detail'),
        buttons: [t('button.ok')],
      });
    };

    try {
      await options.prepareToInstall();
      // Not silent: the installer shows itself. The app starts again afterwards.
      updater.quitAndInstall(false, true);
    } catch (error) {
      await resume(error instanceof Error ? error.name : 'unknown');
      return;
    }
    options.schedule(INSTALL_GRACE_MS, () => {
      if (!options.quitStarted()) void resume('the app did not quit');
    });
  }

  async function run(quiet: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const updater = await configured();
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        if (!quiet) {
          await ask({
            message: t('update.none'),
            detail: t('update.none.detail', { version: options.currentVersion }),
            buttons: [t('button.ok')],
          });
        }
        return;
      }
      const { version } = result.updateInfo;
      const download = await ask({
        message: t('update.available', { version }),
        detail: t('update.available.detail', { current: options.currentVersion }),
        buttons: [t('update.download'), t('button.later')],
      });
      if (download !== 0) return;
      await updater.downloadUpdate();
      const install = await ask({
        message: t('update.downloaded', { version }),
        detail: t('update.downloaded.detail'),
        buttons: [t('update.install'), t('button.later')],
      });
      if (install !== 0) return;
      await installNow(updater);
    } catch (error) {
      logger.warn('update check failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      if (!quiet) await ask({ message: t('update.failed'), buttons: [t('button.ok')] });
    } finally {
      busy = false;
    }
  }

  return {
    available,
    async checkQuietly() {
      if (available) await run(true);
    },
    async checkFromMenu() {
      if (available) {
        await run(false);
        return;
      }
      await ask({
        message: t('update.unsupported'),
        detail: options.disabledByEnvironment
          ? t('update.disabled.detail', { variable: APP.env.updates })
          : t('update.unsupported.detail'),
        buttons: [t('button.ok')],
      });
    },
  };
}
