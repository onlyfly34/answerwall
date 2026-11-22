/**
 * Where things are, and the sandbox every test server runs in: a `PATH` that
 * holds the mock CLIs and Node and nothing else, so a real CLI can never be
 * started from these tests, not even when a mock is missing.
 */
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SERVER_MAIN = path.join(ROOT, 'apps', 'server', 'dist', 'main.js');
export const CORE_MAIN = path.join(ROOT, 'packages', 'core', 'dist', 'index.js');
export const WEB_INDEX = path.join(ROOT, 'packages', 'web', 'dist', 'index.html');
export const MOCK_ROOT = path.join(ROOT, 'tools', 'mock-clis');
export const MOCK_BIN = path.join(MOCK_ROOT, 'bin');

export const CLI_KINDS = ['claude', 'codex', 'agy', 'grok', 'opencode'] as const;
export type CliKind = (typeof CLI_KINDS)[number];

/** Which mock CLIs a server finds on its `PATH`. */
export type MockSet = 'all' | 'without-grok';
const MOCK_SETS: Record<MockSet, readonly CliKind[]> = {
  all: CLI_KINDS,
  'without-grok': ['claude', 'codex', 'agy', 'opencode'],
};

/** Set by the global setup; workers inherit it. */
export const RUN_DIR_ENV = 'E2E_RUN_DIR';

export function runDir(): string {
  const dir = process.env[RUN_DIR_ENV];
  if (!dir) throw new Error(`${RUN_DIR_ENV} is not set: the global setup did not run`);
  return dir;
}

/**
 * The unpacked test extension of the web-cell tests: a copy of
 * `web-cells/extension` with the web UI built into `app/`.
 */
export const webCellsExtensionDir = (): string => path.join(runDir(), 'web-cells-extension');

/** Where running servers register themselves, so the teardown can prove none is left. */
export const registryDir = (): string => path.join(runDir(), 'servers');

const nodeDir = (): string => path.join(runDir(), 'node-bin');
const mockDir = (set: MockSet): string =>
  set === 'all' ? MOCK_BIN : path.join(runDir(), 'mocks', set, 'bin');

/**
 * The directory that provides `node` to the mock launchers. On POSIX it is a
 * private directory with one link in it. Windows keeps Node's own directory
 * (creating a link needs privileges a test cannot assume), after checking
 * that no CLI of the same name sits next to `node.exe`.
 */
function nodePathEntry(): string {
  if (process.platform !== 'win32') return nodeDir();
  const dir = path.dirname(process.execPath);
  for (const kind of CLI_KINDS) {
    for (const extension of ['.cmd', '.exe', '.ps1', '.bat', '']) {
      if (existsSync(path.join(dir, `${kind}${extension}`))) {
        throw new Error(
          `A real "${kind}" sits next to node.exe (${dir}). Run the e2e suite with a Node ` +
            'installation that has no AI CLI installed beside it.',
        );
      }
    }
  }
  return dir;
}

/**
 * Builds the sandbox directories inside the run directory. A reduced mock set
 * gets its own `bin` with copies of the launchers and, next to it, one-line
 * modules that load the real mock sources, so the launchers' relative path
 * (`../src/<kind>.mjs`) keeps working in every launcher form.
 */
export async function prepareSandbox(): Promise<void> {
  await mkdir(registryDir(), { recursive: true });
  if (process.platform !== 'win32') {
    await mkdir(nodeDir(), { recursive: true });
    await symlink(process.execPath, path.join(nodeDir(), 'node'));
    for (const kind of CLI_KINDS) {
      const launcher = path.join(MOCK_BIN, kind);
      if (((await stat(launcher)).mode & 0o111) === 0) await chmod(launcher, 0o755);
    }
  }
  nodePathEntry();

  for (const [set, kinds] of Object.entries(MOCK_SETS) as [MockSet, readonly CliKind[]][]) {
    if (set === 'all') continue;
    const bin = mockDir(set);
    const src = path.join(bin, '..', 'src');
    await mkdir(bin, { recursive: true });
    await mkdir(src, { recursive: true });
    for (const kind of kinds) {
      for (const extension of ['', '.cmd', '.ps1']) {
        const target = path.join(bin, `${kind}${extension}`);
        await copyFile(path.join(MOCK_BIN, `${kind}${extension}`), target);
        if (extension === '') await chmod(target, 0o755);
      }
      const source = pathToFileURL(path.join(MOCK_ROOT, 'src', `${kind}.mjs`)).href;
      await writeFile(path.join(src, `${kind}.mjs`), `import ${JSON.stringify(source)};\n`);
    }
  }
}

const INHERITED = [
  'SystemRoot',
  'SYSTEMROOT',
  'PATHEXT',
  'ComSpec',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
];

/**
 * The whole environment of a test server: nothing of the developer's or the
 * CI job's own environment reaches it except what a process needs to start.
 */
export function sandboxEnv(options: {
  mocks: MockSet;
  home: string;
  extra: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    PATH: [mockDir(options.mocks), nodePathEntry()].join(path.delimiter),
    HOME: options.home,
    USERPROFILE: options.home,
    ...options.extra,
  };
}
