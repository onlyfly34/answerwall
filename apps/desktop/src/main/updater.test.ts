import { describe, expect, test } from 'vitest';
import { createMemoryLogger } from '@answerwall/core/testing';
import { createTranslator, messagesFor } from '../shared/messages/index.ts';
import { createUpdater } from './updater.ts';
import type { UpdaterEngine, UpdaterOptions } from './updater.ts';

const t = createTranslator(messagesFor('en'));

function setup(
  options: {
    newer?: string;
    answers?: number[];
    supported?: boolean;
    disabledByEnvironment?: boolean;
    checkFails?: boolean;
  } = {},
) {
  const events: string[] = [];
  const questions: { message: string; detail?: string; buttons: string[] }[] = [];
  const answers = [...(options.answers ?? [])];
  let loaded = 0;
  const feeds: unknown[] = [];

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
  };
  return {
    updater: createUpdater(updaterOptions),
    engine,
    events,
    questions,
    feeds,
    logger,
    loaded: () => loaded,
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
