import { describe, expect, test } from 'vitest';
import { createMemoryLogger } from '@answerwall/core/testing';
import { createTranslator, messagesFor } from '../shared/messages/index.ts';
import { createUpdater, INSTALL_GRACE_MS } from './updater.ts';
import type { UpdaterEngine, UpdaterOptions } from './updater.ts';

const t = createTranslator(messagesFor('en'));
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(
  options: {
    newer?: string;
    answers?: number[];
    supported?: boolean;
    disabledByEnvironment?: boolean;
    checkFails?: boolean;
    /** How the installation goes wrong, if it does. */
    install?: 'throws' | 'returns';
    resumeFails?: boolean;
  } = {},
) {
  const events: string[] = [];
  const questions: { message: string; detail?: string; buttons: string[] }[] = [];
  const answers = [...(options.answers ?? [])];
  let loaded = 0;
  const feeds: unknown[] = [];
  const timers: { ms: number; task: () => void }[] = [];
  let quitStarted = false;

  const engine: UpdaterEngine = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    logger: null,
    setFeedURL: (feed) => void feeds.push(feed),
    async checkForUpdates() {
      events.push('check');
      if (options.checkFails) throw new Error('net::ERR_INTERNET_DISCONNECTED at /home/me');
      return {
        isUpdateAvailable: options.newer !== undefined,
        updateInfo: { version: options.newer ?? '1.0.0' },
      };
    },
    async downloadUpdate() {
      events.push('download');
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      events.push(`install silent=${isSilent} run=${isForceRunAfter}`);
      if (options.install === 'throws') throw new Error('spawn C:\\Users\\me\\setup.exe EBUSY');
      // An installer that started makes the app quit on the next turn of the event loop.
      if (options.install === undefined) quitStarted = true;
    },
  };

  const logger = createMemoryLogger();
  const updaterOptions: UpdaterOptions = {
    engine: async () => {
      loaded += 1;
      return engine;
    },
    supported: options.supported ?? true,
    disabledByEnvironment: options.disabledByEnvironment ?? false,
    currentVersion: '1.0.0',
    t,
    async ask(question) {
      questions.push(question);
      events.push(`ask: ${question.message}`);
      return answers.shift() ?? question.buttons.length - 1;
    },
    logger,
    async prepareToInstall() {
      events.push('prepare');
    },
    async resumeAfterFailedInstall() {
      events.push('resume');
      if (options.resumeFails) throw new Error('no local server');
    },
    quitStarted: () => quitStarted,
    schedule(ms, task) {
      timers.push({ ms, task });
      return () => undefined;
    },
  };
  return {
    updater: createUpdater(updaterOptions),
    engine,
    events,
    questions,
    feeds,
    logger,
    loaded: () => loaded,
    timers,
  };
}

describe('createUpdater', () => {
  test('reads only this repository’s releases and never acts on its own', async () => {
    const { updater, engine, feeds } = setup();

    await updater.checkQuietly();

    expect(feeds).toEqual([{ provider: 'github', owner: 'onlyfly34', repo: 'answerwall' }]);
    expect(engine).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
    });
  });

  test('the check at start says nothing when there is no update', async () => {
    const { updater, events } = setup();

    await updater.checkQuietly();

    expect(events).toEqual(['check']);
  });

  test('the check from the menu always answers', async () => {
    const { updater, questions } = setup();

    await updater.checkFromMenu();

    expect(questions).toEqual([
      { message: 'You have the latest version.', detail: 'Version 1.0.0', buttons: ['OK'] },
    ]);
  });

  test('asks before downloading and again before installing, which is never silent', async () => {
    const { updater, events, questions } = setup({ newer: '1.1.0', answers: [0, 0] });

    await updater.checkQuietly();

    expect(events).toEqual([
      'check',
      'ask: Version 1.1.0 is available.',
      'download',
      'ask: Version 1.1.0 has been downloaded.',
      'prepare',
      'install silent=false run=true',
    ]);
    expect(questions[0]?.buttons).toEqual(['Download', 'Later']);
    expect(questions[0]?.detail).toContain('not code-signed');
    expect(questions[1]?.buttons).toEqual(['Install and Restart', 'Later']);
  });

  test('an installer that started leaves the app to quit', async () => {
    const { updater, events, timers } = setup({ newer: '1.1.0', answers: [0, 0] });

    await updater.checkQuietly();
    expect(timers.map((timer) => timer.ms)).toEqual([INSTALL_GRACE_MS]);
    timers[0]?.task();
    await flush();

    expect(events).not.toContain('resume');
    expect(events.at(-1)).toBe('install silent=false run=true');
  });

  test('an installation that throws brings the app back and says so', async () => {
    const { updater, events, questions, logger, timers } = setup({
      newer: '1.1.0',
      answers: [0, 0],
      install: 'throws',
    });

    // Also at start, where a failed check says nothing: the user had just agreed to install.
    await updater.checkQuietly();

    expect(events.slice(-4)).toEqual([
      'prepare',
      'install silent=false run=true',
      'resume',
      'ask: The update could not be installed.',
    ]);
    expect(questions.at(-1)?.detail).toContain('keeps running');
    expect(timers).toEqual([]);
    expect(JSON.stringify(logger.entries)).not.toContain('Users');
  });

  test('an installer that never made the app quit brings the app back after a moment', async () => {
    const { updater, events, timers } = setup({
      newer: '1.1.0',
      answers: [0, 0],
      install: 'returns',
    });

    await updater.checkFromMenu();
    expect(events).not.toContain('resume');

    timers[0]?.task();
    await flush();
    expect(events.slice(-2)).toEqual(['resume', 'ask: The update could not be installed.']);

    // Once is enough.
    timers[0]?.task();
    await flush();
    expect(events.filter((event) => event === 'resume')).toHaveLength(1);
  });

  test('the user is told even when the app could not be brought back', async () => {
    const { updater, events } = setup({
      newer: '1.1.0',
      answers: [0, 0],
      install: 'throws',
      resumeFails: true,
    });

    await updater.checkQuietly();

    expect(events.at(-1)).toBe('ask: The update could not be installed.');
  });

  test('"Later" at the first question downloads nothing', async () => {
    const { updater, events } = setup({ newer: '1.1.0', answers: [1] });

    await updater.checkQuietly();

    expect(events).toEqual(['check', 'ask: Version 1.1.0 is available.']);
  });

  test('"Later" at the second question installs nothing', async () => {
    const { updater, events } = setup({ newer: '1.1.0', answers: [0, 1] });

    await updater.checkFromMenu();

    expect(events).not.toContain('prepare');
    expect(events.some((event) => event.startsWith('install'))).toBe(false);
  });

  test('a dialog that is closed counts as "Later"', async () => {
    const { updater, events } = setup({ newer: '1.1.0' });

    await updater.checkQuietly();

    expect(events).toEqual(['check', 'ask: Version 1.1.0 is available.']);
  });

  test('a failed check is silent at start, reported from the menu, and logs no detail', async () => {
    const quiet = setup({ checkFails: true });
    await quiet.updater.checkQuietly();
    expect(quiet.questions).toEqual([]);
    expect(JSON.stringify(quiet.logger.entries)).not.toContain('/home/me');

    const menu = setup({ checkFails: true });
    await menu.updater.checkFromMenu();
    expect(menu.questions.map((question) => question.message)).toEqual([
      'The update check failed.',
    ]);
  });

  test('a second check while one is running does nothing', async () => {
    const { updater, events } = setup();

    await Promise.all([updater.checkQuietly(), updater.checkQuietly()]);

    expect(events).toEqual(['check']);
  });

  test.each([
    [{ supported: false }, 'Updates are installed by the Windows installer of a release.'],
    [{ disabledByEnvironment: true }, 'Updates are switched off by ANSWERWALL_DESKTOP_UPDATES.'],
  ])('a build that cannot update never loads the updater: %j', async (options, detail) => {
    const { updater, events, questions, loaded } = setup({ ...options, newer: '1.1.0' });

    expect(updater.available).toBe(false);
    await updater.checkQuietly();
    expect(events).toEqual([]);

    await updater.checkFromMenu();
    expect(questions).toEqual([
      { message: 'This build does not update itself.', detail, buttons: ['OK'] },
    ]);
    expect(loaded()).toBe(0);
  });
});
