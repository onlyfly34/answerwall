import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * `pnpm smoke:real` calls the real CLIs with the owner's account. It is a
 * manual command: no workflow, no other package script and no other script
 * may start it, so that CI and every automated check stay on the mocks.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = 'smoke-real';
const COMMAND = 'smoke:real';
const mentions = (text: string): boolean => text.includes(SCRIPT) || text.includes(COMMAND);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}

function manifests(): string[] {
  const groups = ['packages', 'apps', 'tools'].flatMap((group) =>
    readdirSync(path.join(ROOT, group)).map((name) => path.join(ROOT, group, name)),
  );
  return [ROOT, path.join(ROOT, 'e2e'), ...groups]
    .map((dir) => path.join(dir, 'package.json'))
    .filter((file) => existsSync(file));
}

const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

describe('the real-CLI smoke test stays a manual command', () => {
  test('the script exists and the root manifest starts it as smoke:real only', () => {
    expect(existsSync(path.join(ROOT, 'scripts', `${SCRIPT}.mjs`))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts[COMMAND]).toContain(`scripts/${SCRIPT}.mjs`);
  });

  test('no workflow or composite action mentions it', () => {
    const files = filesUnder(path.join(ROOT, '.github'));
    expect(files.length).toBeGreaterThan(0);

    expect(files.filter((file) => mentions(readFileSync(file, 'utf8'))).map(relative)).toEqual([]);
  });

  test('no package script other than smoke:real mentions it', () => {
    const offenders = manifests().flatMap((file) => {
      const { scripts = {} } = JSON.parse(readFileSync(file, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      return Object.entries(scripts)
        .filter(([name, command]) => {
          const isTheCommand = file === path.join(ROOT, 'package.json') && name === COMMAND;
          return !isTheCommand && (mentions(name) || mentions(command));
        })
        .map(([name]) => `${relative(file)}: ${name}`);
    });

    expect(offenders).toEqual([]);
  });

  test('no other script, test support file or mock starts it', () => {
    const sources = [
      ...filesUnder(path.join(ROOT, 'scripts')),
      ...filesUnder(path.join(ROOT, 'e2e', 'support')),
      ...filesUnder(path.join(ROOT, 'e2e', 'tests')),
      ...filesUnder(path.join(ROOT, 'tools', 'mock-clis', 'src')),
      ...filesUnder(path.join(ROOT, 'apps', 'server', 'src')),
      path.join(ROOT, 'e2e', 'playwright.config.ts'),
    ].filter(
      (file) =>
        existsSync(file) &&
        relative(file) !== `scripts/${SCRIPT}.mjs` &&
        relative(file) !== 'tools/mock-clis/src/real-smoke-guard.test.ts',
    );

    expect(sources.filter((file) => mentions(readFileSync(file, 'utf8'))).map(relative)).toEqual(
      [],
    );
  });

  test('the script itself refuses to run in CI and without a confirmation', () => {
    const script = readFileSync(path.join(ROOT, 'scripts', `${SCRIPT}.mjs`), 'utf8');

    expect(script).toContain('process.env.CI');
    expect(script).toContain("'--yes'");
    expect(script).toContain('isTTY');
  });
});
