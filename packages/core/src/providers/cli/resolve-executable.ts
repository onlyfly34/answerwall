import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** What to hand to `spawn`: `file` with `prefixArgs` before the adapter's own arguments. */
export interface ResolvedCommand {
  file: string;
  prefixArgs: string[];
}

export type ResolveResult =
  | { found: true; command: ResolvedCommand }
  /**
   * `unsupported_shim`: PATH has a launcher script that cannot be reduced to a
   * real executable. It is never run through a shell instead.
   */
  | { found: false; reason: 'not_found' | 'unsupported_shim' };

/** The file system as the resolver sees it; replaced in tests by synthetic layouts. */
export interface ResolverFs {
  isFile(file: string): Promise<boolean>;
  /** A regular file the current user may execute. Only asked on POSIX. */
  isExecutable(file: string): Promise<boolean>;
  readText(file: string): Promise<string>;
}

export const nodeResolverFs: ResolverFs = {
  async isFile(file) {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  },
  async isExecutable(file) {
    try {
      if (!(await stat(file)).isFile()) return false;
      await access(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: (file) => readFile(file, 'utf8'),
};

export interface ResolveOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fs?: ResolverFs;
}

/** Reads a variable the way the platform does: case-insensitively on Windows. */
export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name];
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const NATIVE_EXTENSIONS = ['.exe', '.com'];
const NODE_SCRIPT_EXTENSIONS = ['.js', '.cjs', '.mjs'];

/**
 * Finds `name` on PATH and reduces it to something `spawn` can start without
 * a shell. On Windows a `.cmd`/`.bat`/`.ps1` launcher written by npm is
 * replaced by the program it starts: `node <script>` or the `.exe` itself.
 */
export async function resolveExecutable(
  name: string,
  options: ResolveOptions,
): Promise<ResolveResult> {
  if (name === '' || /[\\/]/.test(name)) {
    throw new Error('resolveExecutable takes a bare command name');
  }
  const fs = options.fs ?? nodeResolverFs;
  return options.platform === 'win32'
    ? resolveOnWindows(name, options.env, fs)
    : resolveOnPosix(name, options.env, fs);
}

async function resolveOnPosix(
  name: string,
  env: NodeJS.ProcessEnv,
  fs: ResolverFs,
): Promise<ResolveResult> {
  for (const dir of (env.PATH ?? '').split(':')) {
    // An empty or relative entry means "the current directory"; never trusted.
    if (!path.posix.isAbsolute(dir)) continue;
    const candidate = path.posix.join(dir, name);
    if (await fs.isExecutable(candidate)) {
      return { found: true, command: { file: candidate, prefixArgs: [] } };
    }
  }
  return { found: false, reason: 'not_found' };
}

function windowsPathDirs(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, 'PATH', 'win32') ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => path.win32.isAbsolute(dir));
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const listed = (envValue(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
  // npm also writes a PowerShell launcher; it is the last resort.
  return listed.includes('.ps1') ? listed : [...listed, '.ps1'];
}

async function resolveOnWindows(
  name: string,
  env: NodeJS.ProcessEnv,
  fs: ResolverFs,
): Promise<ResolveResult> {
  const dirs = windowsPathDirs(env);
  const extensions = windowsExtensions(env);
  const given = path.win32.extname(name).toLowerCase();
  const suffixes = extensions.includes(given) ? [''] : extensions;

  for (const dir of dirs) {
    let sawLauncher = false;
    for (const suffix of suffixes) {
      const candidate = path.win32.join(dir, name + suffix);
      const extension = suffix === '' ? given : suffix;
      if (!(await fs.isFile(candidate))) continue;
      if (NATIVE_EXTENSIONS.includes(extension)) {
        return { found: true, command: { file: candidate, prefixArgs: [] } };
      }
      if (extension !== '.cmd' && extension !== '.bat' && extension !== '.ps1') continue;
      sawLauncher = true;
      const target = await launcherTarget(candidate, extension, fs);
      const command = target && (await commandForTarget(target, dir, dirs, fs));
      if (command) return { found: true, command };
    }
    // The shell would have run this launcher; do not silently pick another install.
    if (sawLauncher) return { found: false, reason: 'unsupported_shim' };
  }
  return { found: false, reason: 'not_found' };
}

async function launcherTarget(
  launcher: string,
  extension: string,
  fs: ResolverFs,
): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readText(launcher);
  } catch {
    return null;
  }
  const dir = path.win32.dirname(launcher);
  return extension === '.ps1' ? powershellShimTarget(text, dir) : cmdShimTarget(text, dir);
}

const isNodeBinary = (file: string): boolean => /^node(\.exe)?$/i.test(path.win32.basename(file));

/**
 * The program an npm `.cmd` launcher starts: the last quoted path relative to
 * the launcher's own directory (`%~dp0` or `%dp0%`) on the line that forwards
 * the arguments (`%*`), ignoring the bundled `node.exe`.
 */
export function cmdShimTarget(text: string, shimDir: string): string | null {
  const line = text
    .split(/\r?\n/)
    .filter((candidate) => candidate.includes('%*'))
    .at(-1);
  if (line === undefined) return null;
  const targets = [...line.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1] ?? '')
    .filter((quoted) => /%~dp0|%dp0%/i.test(quoted))
    // A replacer function: a `$` in the directory name must not be read as a replacement pattern.
    .map((quoted) => quoted.replace(/(%~dp0|%dp0%)\\?/gi, () => `${shimDir}\\`))
    .map((expanded) => path.win32.normalize(expanded))
    .filter((expanded) => !isNodeBinary(expanded));
  return targets.at(-1) ?? null;
}

/** The same for npm's PowerShell launcher, whose paths are `"$basedir/…"`. */
export function powershellShimTarget(text: string, shimDir: string): string | null {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('$args')) continue;
    for (const match of line.matchAll(/"\$basedir[\\/]([^"]*)"/g)) {
      const relative = (match[1] ?? '').replace(/\$exe$/, '.exe');
      const expanded = path.win32.normalize(path.win32.join(shimDir, relative));
      if (!isNodeBinary(expanded)) targets.push(expanded);
    }
  }
  return targets.at(-1) ?? null;
}

async function commandForTarget(
  target: string,
  shimDir: string,
  pathDirs: string[],
  fs: ResolverFs,
): Promise<ResolvedCommand | null> {
  if (!(await fs.isFile(target))) return null;
  const extension = path.win32.extname(target).toLowerCase();
  if (NATIVE_EXTENSIONS.includes(extension)) return { file: target, prefixArgs: [] };
  if (!NODE_SCRIPT_EXTENSIONS.includes(extension) && !(await hasNodeShebang(target, fs))) {
    return null;
  }
  const node = await findNode(shimDir, pathDirs, fs);
  return node === null ? null : { file: node, prefixArgs: [target] };
}

async function hasNodeShebang(file: string, fs: ResolverFs): Promise<boolean> {
  try {
    const firstLine = (await fs.readText(file)).split(/\r?\n/, 1)[0] ?? '';
    return /^#!.*\bnode\b/.test(firstLine);
  } catch {
    return false;
  }
}

/** npm's launcher prefers a `node.exe` next to itself, then the one on PATH. */
async function findNode(
  shimDir: string,
  pathDirs: string[],
  fs: ResolverFs,
): Promise<string | null> {
  for (const dir of [shimDir, ...pathDirs]) {
    const candidate = path.win32.join(dir, 'node.exe');
    if (await fs.isFile(candidate)) return candidate;
  }
  return null;
}
