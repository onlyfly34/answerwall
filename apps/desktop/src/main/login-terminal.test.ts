import { describe, expect, test } from 'vitest';
import { CLI_PROVIDER_KINDS, LOGIN_COMMANDS } from '@answerwall/core/protocol';
import { loginCommandFor, openLoginTerminal, terminalLaunches } from './login-terminal.ts';
import type { TerminalLaunch } from './login-terminal.ts';

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
const CMD = 'C:\\Windows\\System32\\cmd.exe';

describe('loginCommandFor', () => {
  test('knows exactly the CLI kinds and gives the command of the shared table', () => {
    for (const kind of CLI_PROVIDER_KINDS) expect(loginCommandFor(kind)).toBe(LOGIN_COMMANDS[kind]);
    expect(loginCommandFor('claude')).toBe('claude auth login');
  });

  test.each([
    'openai-compat',
    'claude auth login',
    'claude && calc',
    'Claude',
    ' claude',
    'calc.exe',
    '__proto__',
    'constructor',
    'toString',
    '',
    undefined,
    null,
    0,
    ['claude'],
    { kind: 'claude' },
  ])('refuses %j', (kind) => {
    expect(loginCommandFor(kind)).toBeUndefined();
  });
});

describe('terminalLaunches', () => {
  test('Windows: Windows Terminal first, then a console window of cmd', () => {
    expect(
      terminalLaunches('win32', 'claude auth login', 'AnswerWall: log in', WINDOWS_ENV),
    ).toEqual([
      {
        file: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
        args: [
          'new-tab',
          '--title',
          'AnswerWall: log in',
          CMD,
          '/d',
          '/k',
          'claude',
          'auth',
          'login',
        ],
      },
      {
        file: CMD,
        args: ['/d', '/s', '/c', `"start "AnswerWall: log in" "${CMD}" /d /k claude auth login"`],
        verbatim: true,
      },
    ]);
  });

  test('Windows without the usual variables still has a way', () => {
    expect(terminalLaunches('win32', 'codex login', 'T', {})).toEqual([
      {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', '"start "T" "cmd.exe" /d /k codex login"'],
        verbatim: true,
      },
    ]);
  });

  test('the variables are found whatever their case', () => {
    const launches = terminalLaunches('win32', 'agy', 'T', { SYSTEMROOT: 'D:\\Win' });

    expect(launches.at(-1)?.file).toBe('D:\\Win\\System32\\cmd.exe');
  });

  test('a title cannot carry anything the shell would act on', () => {
    const [terminal, console] = terminalLaunches(
      'win32',
      'codex login',
      'A" & calc.exe & "%PATH% ^| x',
      WINDOWS_ENV,
    );

    expect(terminal?.args[2]).toBe('A  calc.exe  PATH  x');
    expect(console?.args.at(-1)).toBe(`"start "A  calc.exe  PATH  x" "${CMD}" /d /k codex login"`);
  });

  test.each([
    'claude auth login & calc',
    'claude "auth"',
    'claude auth login\nwhoami',
    'claude %USERPROFILE%',
    'claude  auth',
    '../claude',
    'C:\\tools\\claude.exe',
    'Claude',
    '',
  ])('refuses the command %j: only plain words are ever run', (command) => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(() => terminalLaunches(platform, command, 'T', WINDOWS_ENV)).toThrow();
    }
  });

  test('every command of the table is plain words', () => {
    for (const command of Object.values(LOGIN_COMMANDS)) {
      expect(() => terminalLaunches('win32', command, 'T', {})).not.toThrow();
    }
  });

  test('Linux tries the usual terminal emulators; macOS asks Terminal', () => {
    const linux = terminalLaunches('linux', 'grok login --device-auth', 'T', {});
    expect(linux[0]).toEqual({
      file: 'x-terminal-emulator',
      args: ['-e', 'grok', 'login', '--device-auth'],
    });
    expect(linux.every((launch) => launch.verbatim === undefined)).toBe(true);

    const [mac] = terminalLaunches('darwin', 'codex login', 'T', {});
    expect(mac?.file).toBe('/usr/bin/osascript');
    expect(mac?.args).toContain('tell application "Terminal" to do script "codex login"');
  });
});

describe('openLoginTerminal', () => {
  const options = (start: (launch: TerminalLaunch) => Promise<boolean>) => ({
    platform: 'win32' as const,
    title: 'T',
    env: WINDOWS_ENV,
    start,
  });

  test('starts the first terminal that works', async () => {
    const tried: string[] = [];
    const result = await openLoginTerminal(
      'codex',
      options(async (launch) => {
        tried.push(launch.file);
        return launch.file === CMD;
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(tried).toEqual(['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe', CMD]);
  });

  test('stops at the first success', async () => {
    const tried: string[] = [];
    await openLoginTerminal(
      'codex',
      options(async (launch) => {
        tried.push(launch.file);
        return true;
      }),
    );

    expect(tried).toHaveLength(1);
  });

  test('says so when no terminal starts', async () => {
    expect(
      await openLoginTerminal(
        'grok',
        options(async () => false),
      ),
    ).toEqual({
      ok: false,
      reason: 'no_terminal',
    });
  });

  test('starts nothing for anything but a known CLI kind', async () => {
    let started = 0;
    const start = async (): Promise<boolean> => {
      started += 1;
      return true;
    };

    for (const kind of ['calc.exe', 'claude auth login', 'openai-compat', null, { a: 1 }]) {
      expect(await openLoginTerminal(kind, options(start))).toEqual({
        ok: false,
        reason: 'unknown_provider',
      });
    }
    expect(started).toBe(0);
  });
});
