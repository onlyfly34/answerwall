/**
 * "Open a terminal to log in": starts an external terminal window that runs
 * one CLI's official login command. The app never runs the command itself
 * and never sees the terminal's input or output (docs/DECISIONS.md §2.2).
 *
 * The page names a provider kind, never a command: the command comes from
 * the fixed table in core's protocol and from nowhere else.
 */
import path from 'node:path';
import { CLI_PROVIDER_KINDS, LOGIN_COMMANDS } from '@answerwall/core/protocol';
import type { CliProviderKind, LoginTerminalResult } from '@answerwall/core/protocol';

/** The login command for what a page sent, or `undefined` for anything but a known CLI kind. */
export function loginCommandFor(kind: unknown): string | undefined {
  if (typeof kind !== 'string') return undefined;
  if (!(CLI_PROVIDER_KINDS as readonly string[]).includes(kind)) return undefined;
  return LOGIN_COMMANDS[kind as CliProviderKind];
}

/** One way to open a terminal: an executable and its arguments, never a shell string from outside. */
export interface TerminalLaunch {
  file: string;
  args: string[];
  /** Windows: `args` are already one command line and must not be quoted again. */
  verbatim?: boolean;
}

/** Only words of lower-case letters, digits and dashes: nothing a shell would interpret. */
const PLAIN_COMMAND = /^[a-z][a-z0-9-]*( [a-z0-9-]+)*$/;
/** A window title is shown, and on Windows passes through `cmd`: keep it to harmless characters. */
const PLAIN_TITLE = /[^\p{L}\p{N} .:_-]/gu;

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === undefined || value === '' ? undefined : value;
};

/**
 * The terminals to try, in order, for a command of the fixed table.
 * Windows: Windows Terminal, else a console window of `cmd`. The terminal
 * stays open after the command so that its output can be read.
 * @throws Error for a command that is not plain words; the table holds none.
 */
export function terminalLaunches(
  platform: NodeJS.Platform,
  command: string,
  title: string,
  env: NodeJS.ProcessEnv,
): TerminalLaunch[] {
  if (!PLAIN_COMMAND.test(command)) throw new Error('Not a plain login command');
  const words = command.split(' ');
  const safeTitle = title.replace(PLAIN_TITLE, '');

  if (platform === 'win32') {
    const systemRoot = envValue(env, 'SystemRoot');
    const cmd = systemRoot ? path.win32.join(systemRoot, 'System32', 'cmd.exe') : 'cmd.exe';
    const launches: TerminalLaunch[] = [];
    // Windows Terminal installs an alias here; it is not always on PATH.
    const localAppData = envValue(env, 'LOCALAPPDATA');
    if (localAppData) {
      launches.push({
        file: path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'),
        args: ['new-tab', '--title', safeTitle, cmd, '/d', '/k', ...words],
      });
    }
    // `start` gives the inner `cmd` a console window of its own. With /s, the
    // outer `cmd` takes everything between the first and the last quote as is.
    launches.push({
      file: cmd,
      args: ['/d', '/s', '/c', `"start "${safeTitle}" "${cmd}" /d /k ${command}"`],
      verbatim: true,
    });
    return launches;
  }

  if (platform === 'darwin') {
    return [
      {
        file: '/usr/bin/osascript',
        args: [
          '-e',
          `tell application "Terminal" to do script "${command}"`,
          '-e',
          'tell application "Terminal" to activate',
        ],
      },
    ];
  }

  return [
    { file: 'x-terminal-emulator', args: ['-e', ...words] },
    { file: 'gnome-terminal', args: ['--', ...words] },
    { file: 'konsole', args: ['-e', ...words] },
    { file: 'xterm', args: ['-e', ...words] },
  ];
}

/** Starts a process that is not waited for; resolves whether it started. */
export type Starter = (launch: TerminalLaunch) => Promise<boolean>;

/** Tries each launch until one starts. */
export async function openLoginTerminal(
  kind: unknown,
  options: {
    platform: NodeJS.Platform;
    title: string;
    env: NodeJS.ProcessEnv;
    start: Starter;
  },
): Promise<LoginTerminalResult> {
  const command = loginCommandFor(kind);
  if (command === undefined) return { ok: false, reason: 'unknown_provider' };
  for (const launch of terminalLaunches(options.platform, command, options.title, options.env)) {
    if (await options.start(launch)) return { ok: true };
  }
  return { ok: false, reason: 'no_terminal' };
}
