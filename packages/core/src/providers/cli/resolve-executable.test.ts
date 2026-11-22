import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  cmdShimTarget,
  envValue,
  powershellShimTarget,
  resolveExecutable,
} from './resolve-executable.ts';
import type { ResolverFs } from './resolve-executable.ts';

interface Entry {
  /** File content, for launchers and scripts. */
  text?: string;
  /** POSIX execute permission; defaults to true. */
  executable?: boolean;
}

/** A synthetic directory layout. Windows file names are case-insensitive. */
function layout(platform: 'posix' | 'win32', files: Record<string, Entry | string>): ResolverFs {
  const key = (file: string): string => (platform === 'win32' ? file.toLowerCase() : file);
  const entries = new Map(
    Object.entries(files).map(([file, entry]) => [
      key(file),
      typeof entry === 'string' ? { text: entry } : entry,
    ]),
  );
  return {
    isFile: async (file) => entries.has(key(file)),
    isExecutable: async (file) => entries.get(key(file))?.executable ?? entries.has(key(file)),
    async readText(file) {
      const entry = entries.get(key(file));
      if (entry === undefined) throw new Error('ENOENT');
      return entry.text ?? '';
    },
  };
}

/** The launcher npm (cmd-shim) writes for a package whose bin is a Node script. */
const npmCmdShim = (target: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    '',
  ].join('\r\n');

/** The older launcher form, with `%~dp0` inline. */
const legacyCmdShim = (target: string): string =>
  [
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${target}" %*`,
    ')',
  ].join('\r\n');

const npmPs1Shim = (target: string): string =>
  [
    '#!/usr/bin/env pwsh',
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    '}',
    'if (Test-Path "$basedir/node$exe") {',
    `  & "$basedir/node$exe"  "$basedir/${target}" $args`,
    '} else {',
    `  & "node$exe"  "$basedir/${target}" $args`,
    '}',
    'exit $LASTEXITCODE',
  ].join('\n');

describe('resolveExecutable on POSIX', () => {
  const resolve = (env: NodeJS.ProcessEnv, fs: ResolverFs) =>
    resolveExecutable('tool', { env, platform: 'linux', fs });

  test('returns the first executable in PATH order', async () => {
    const fs = layout('posix', { '/opt/a/tool': {}, '/usr/bin/tool': {} });

    expect(await resolve({ PATH: '/usr/local/bin:/opt/a:/usr/bin' }, fs)).toEqual({
      found: true,
      command: { file: '/opt/a/tool', prefixArgs: [] },
    });
  });

  test('skips a file without execute permission', async () => {
    const fs = layout('posix', { '/opt/a/tool': { executable: false }, '/usr/bin/tool': {} });

    expect(await resolve({ PATH: '/opt/a:/usr/bin' }, fs)).toEqual({
      found: true,
      command: { file: '/usr/bin/tool', prefixArgs: [] },
    });
  });

  test('never looks in the current directory: empty and relative PATH entries are skipped', async () => {
    const fs = layout('posix', { tool: {}, 'bin/tool': {}, './tool': {} });

    expect(await resolve({ PATH: ':.:bin::' }, fs)).toEqual({ found: false, reason: 'not_found' });
  });

  test.each([{}, { PATH: '' }, { PATH: '/usr/bin' }])(
    'reports not_found with PATH %j',
    async (env) => {
      expect(await resolve(env, layout('posix', {}))).toEqual({
        found: false,
        reason: 'not_found',
      });
    },
  );

  test('does not apply Windows rules: PATHEXT and launchers mean nothing', async () => {
    const fs = layout('posix', { '/usr/bin/tool.cmd': {}, '/usr/bin/tool.exe': {} });

    expect(await resolve({ PATH: '/usr/bin', PATHEXT: '.EXE;.CMD' }, fs)).toEqual({
      found: false,
      reason: 'not_found',
    });
  });

  test.each(['', '../tool', '/usr/bin/tool', 'dir\\tool'])(
    'refuses %j: only bare command names are looked up',
    async (name) => {
      await expect(
        resolveExecutable(name, { env: { PATH: '/usr/bin' }, platform: 'linux' }),
      ).rejects.toThrow('bare command name');
    },
  );
});

describe('resolveExecutable on Windows', () => {
  const NODE = 'C:\\Program Files\\nodejs';
  const NPM = 'C:\\Users\\someone\\AppData\\Roaming\\npm';
  const resolve = (env: NodeJS.ProcessEnv, fs: ResolverFs, name = 'tool') =>
    resolveExecutable(name, { env, platform: 'win32', fs });

  test('finds a native executable through PATHEXT', async () => {
    const fs = layout('win32', { 'C:\\Tools\\tool.exe': {} });

    expect(
      await resolve({ PATH: 'C:\\Other;C:\\Tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, fs),
    ).toEqual({
      found: true,
      command: { file: 'C:\\Tools\\tool.exe', prefixArgs: [] },
    });
  });

  test('reads PATH and PATHEXT whatever their spelling, and unquotes PATH entries', async () => {
    const fs = layout('win32', { 'C:\\My Tools\\TOOL.EXE': {} });

    expect(await resolve({ Path: '"C:\\My Tools";C:\\Other', PathExt: '.exe' }, fs)).toEqual({
      found: true,
      command: { file: 'C:\\My Tools\\tool.exe', prefixArgs: [] },
    });
  });

  test('uses the default extensions when PATHEXT is missing or empty', async () => {
    const fs = layout('win32', { 'C:\\Tools\\tool.com': {} });

    for (const env of [{ PATH: 'C:\\Tools' }, { PATH: 'C:\\Tools', PATHEXT: '' }]) {
      expect(await resolve(env, fs)).toEqual({
        found: true,
        command: { file: 'C:\\Tools\\tool.com', prefixArgs: [] },
      });
    }
  });

  test('ignores the extensionless POSIX launcher npm puts next to the shims', async () => {
    const fs = layout('win32', { 'C:\\Tools\\tool': '#!/bin/sh\n' });

    expect(await resolve({ PATH: 'C:\\Tools' }, fs)).toEqual({ found: false, reason: 'not_found' });
  });

  test('skips relative PATH entries', async () => {
    const fs = layout('win32', { 'bin\\tool.exe': {}, 'tool.exe': {} });

    expect(await resolve({ PATH: 'bin;.;' }, fs)).toEqual({ found: false, reason: 'not_found' });
  });

  test('prefers a native executable over a launcher in the same directory', async () => {
    const fs = layout('win32', {
      'C:\\Tools\\tool.exe': {},
      'C:\\Tools\\tool.cmd': npmCmdShim('node_modules\\tool\\cli.js'),
    });

    expect(await resolve({ PATH: 'C:\\Tools' }, fs)).toEqual({
      found: true,
      command: { file: 'C:\\Tools\\tool.exe', prefixArgs: [] },
    });
  });

  test('reduces an npm .cmd shim to node.exe from PATH plus the script', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.cmd`]: npmCmdShim('node_modules\\@vendor\\tool\\bin\\cli.js'),
      [`${NPM}\\node_modules\\@vendor\\tool\\bin\\cli.js`]: '#!/usr/bin/env node\n',
      [`${NODE}\\node.exe`]: {},
    });

    expect(await resolve({ PATH: `${NPM};${NODE}` }, fs)).toEqual({
      found: true,
      command: {
        file: `${NODE}\\node.exe`,
        prefixArgs: [`${NPM}\\node_modules\\@vendor\\tool\\bin\\cli.js`],
      },
    });
  });

  test('prefers the node.exe that sits next to the shim, as the shim itself does', async () => {
    const fs = layout('win32', {
      [`${NODE}\\tool.cmd`]: npmCmdShim('node_modules\\tool\\cli.mjs'),
      [`${NODE}\\node_modules\\tool\\cli.mjs`]: '',
      [`${NODE}\\node.exe`]: {},
      'C:\\Other\\node.exe': {},
    });

    expect(await resolve({ PATH: `C:\\Other;${NODE}` }, fs)).toEqual({
      found: true,
      command: { file: `${NODE}\\node.exe`, prefixArgs: [`${NODE}\\node_modules\\tool\\cli.mjs`] },
    });
  });

  test('understands the older shim form with %~dp0', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.cmd`]: legacyCmdShim('node_modules\\tool\\cli.js'),
      [`${NPM}\\node_modules\\tool\\cli.js`]: '',
      [`${NODE}\\node.exe`]: {},
    });

    expect(await resolve({ PATH: `${NPM};${NODE}` }, fs)).toEqual({
      found: true,
      command: { file: `${NODE}\\node.exe`, prefixArgs: [`${NPM}\\node_modules\\tool\\cli.js`] },
    });
  });

  test('accepts an extensionless script with a node shebang', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.cmd`]: npmCmdShim('node_modules\\tool\\bin\\tool'),
      [`${NPM}\\node_modules\\tool\\bin\\tool`]: '#!/usr/bin/env node\nconsole.log(1)\n',
      [`${NODE}\\node.exe`]: {},
    });

    expect(await resolve({ PATH: `${NPM};${NODE}` }, fs)).toEqual({
      found: true,
      command: { file: `${NODE}\\node.exe`, prefixArgs: [`${NPM}\\node_modules\\tool\\bin\\tool`] },
    });
  });

  test('reduces a shim that starts a packaged .exe to that .exe', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.cmd`]: [
        '@ECHO off',
        'SETLOCAL',
        'SET dp0=%~dp0',
        '"%dp0%\\node_modules\\@vendor\\tool-win32-x64\\tool.exe"   %*',
      ].join('\r\n'),
      [`${NPM}\\node_modules\\@vendor\\tool-win32-x64\\tool.exe`]: {},
    });

    expect(await resolve({ PATH: NPM }, fs)).toEqual({
      found: true,
      command: {
        file: `${NPM}\\node_modules\\@vendor\\tool-win32-x64\\tool.exe`,
        prefixArgs: [],
      },
    });
  });

  test('falls back to the PowerShell shim when it is the only launcher', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.ps1`]: npmPs1Shim('node_modules/tool/cli.js'),
      [`${NPM}\\node_modules\\tool\\cli.js`]: '',
      [`${NODE}\\node.exe`]: {},
    });

    expect(await resolve({ PATH: `${NPM};${NODE}`, PATHEXT: '.EXE;.CMD' }, fs)).toEqual({
      found: true,
      command: { file: `${NODE}\\node.exe`, prefixArgs: [`${NPM}\\node_modules\\tool\\cli.js`] },
    });
  });

  test('uses the PowerShell shim when the .cmd next to it cannot be reduced', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.cmd`]: '@echo off\r\ncall something-else %*\r\n',
      [`${NPM}\\tool.ps1`]: npmPs1Shim('node_modules/tool/cli.js'),
      [`${NPM}\\node_modules\\tool\\cli.js`]: '',
      [`${NODE}\\node.exe`]: {},
    });

    expect(await resolve({ PATH: `${NPM};${NODE}` }, fs)).toMatchObject({
      found: true,
      command: { file: `${NODE}\\node.exe` },
    });
  });

  test.each([
    ['a hand-written batch file', { [`${NPM}\\tool.cmd`]: '@echo off\r\npython -m tool %*\r\n' }],
    ['a .bat without argument forwarding', { [`${NPM}\\tool.bat`]: '@echo hello\r\n' }],
    [
      'a shim whose script is missing',
      { [`${NPM}\\tool.cmd`]: npmCmdShim('node_modules\\tool\\cli.js') },
    ],
    [
      'a shim whose target is neither a node script nor an executable',
      {
        [`${NPM}\\tool.cmd`]: npmCmdShim('node_modules\\tool\\run.py'),
        [`${NPM}\\node_modules\\tool\\run.py`]: '#!/usr/bin/env python\n',
      },
    ],
  ])(
    'reports unsupported_shim for %s, and never another install further down PATH',
    async (_, files) => {
      const fs = layout('win32', {
        ...files,
        [`${NODE}\\node.exe`]: {},
        'C:\\Later\\tool.exe': {},
      });

      expect(await resolve({ PATH: `${NPM};${NODE};C:\\Later` }, fs)).toEqual({
        found: false,
        reason: 'unsupported_shim',
      });
    },
  );

  test('reports unsupported_shim when a node script has no node.exe to run it', async () => {
    const fs = layout('win32', {
      [`${NPM}\\tool.cmd`]: npmCmdShim('node_modules\\tool\\cli.js'),
      [`${NPM}\\node_modules\\tool\\cli.js`]: '',
    });

    expect(await resolve({ PATH: NPM }, fs)).toEqual({ found: false, reason: 'unsupported_shim' });
  });

  test('a name that already carries an executable extension is looked up as it is', async () => {
    const fs = layout('win32', { 'C:\\Tools\\tool.exe': {}, 'C:\\Tools\\tool.exe.cmd': '' });

    expect(await resolve({ PATH: 'C:\\Tools' }, fs, 'tool.exe')).toEqual({
      found: true,
      command: { file: 'C:\\Tools\\tool.exe', prefixArgs: [] },
    });
  });

  test('a dotted name without an executable extension still gets PATHEXT applied', async () => {
    const fs = layout('win32', { 'C:\\Tools\\tool.v2.exe': {} });

    expect(await resolve({ PATH: 'C:\\Tools' }, fs, 'tool.v2')).toEqual({
      found: true,
      command: { file: 'C:\\Tools\\tool.v2.exe', prefixArgs: [] },
    });
  });
});

describe('shim parsing', () => {
  test('cmdShimTarget returns null without an argument-forwarding line', () => {
    expect(cmdShimTarget('@echo off\r\necho hi\r\n', 'C:\\x')).toBeNull();
  });

  test('cmdShimTarget ignores quoted paths outside the shim directory', () => {
    expect(
      cmdShimTarget('"C:\\Windows\\System32\\cmd.exe" /c "D:\\tool.cmd" %*', 'C:\\x'),
    ).toBeNull();
  });

  test('cmdShimTarget normalises parent-directory segments', () => {
    expect(cmdShimTarget('"%dp0%\\..\\src\\cli.mjs" %*', 'C:\\pkg\\bin')).toBe(
      'C:\\pkg\\src\\cli.mjs',
    );
  });

  test('cmdShimTarget takes a `$` in the directory name literally', () => {
    for (const dir of ['C:\\Users\\J $& Smith\\npm', 'C:\\a $1 b', "C:\\a $` $' b"]) {
      expect(cmdShimTarget('"%_prog%"  "%dp0%\\node_modules\\x\\bin\\x.js" %*', dir)).toBe(
        `${dir}\\node_modules\\x\\bin\\x.js`,
      );
    }
  });

  test('powershellShimTarget returns null when no line passes the arguments on', () => {
    expect(powershellShimTarget('Write-Host "$basedir/x.js"', 'C:\\x')).toBeNull();
  });

  test('powershellShimTarget resolves a packaged executable named with $exe', () => {
    expect(powershellShimTarget('& "$basedir/vendor/tool$exe" $args', 'C:\\x')).toBe(
      'C:\\x\\vendor\\tool.exe',
    );
  });
});

describe('the mock CLI launchers', () => {
  const bin = new URL('../../../../../tools/mock-clis/bin/', import.meta.url);

  test.each(['claude', 'codex', 'agy', 'grok', 'opencode'])(
    'the %s .cmd and .ps1 shims reduce to the mock script',
    async (kind) => {
      const cmd = await readFile(new URL(`${kind}.cmd`, bin), 'utf8');
      const ps1 = await readFile(new URL(`${kind}.ps1`, bin), 'utf8');
      const script = `C:\\repo\\tools\\mock-clis\\src\\${kind}.mjs`;

      expect(cmdShimTarget(cmd, 'C:\\repo\\tools\\mock-clis\\bin')).toBe(script);
      expect(powershellShimTarget(ps1, 'C:\\repo\\tools\\mock-clis\\bin')).toBe(script);
    },
  );
});

describe('envValue', () => {
  test('is exact on POSIX and case-insensitive on Windows', () => {
    const env = { Path: 'x' };

    expect(envValue(env, 'PATH', 'linux')).toBeUndefined();
    expect(envValue(env, 'PATH', 'win32')).toBe('x');
    expect(envValue({}, 'PATH', 'win32')).toBeUndefined();
  });
});
