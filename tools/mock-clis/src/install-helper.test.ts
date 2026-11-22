import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * The container's install helper (`docker/install-cli.sh`), run for real
 * with a stand-in for `curl` first on its `PATH`: the "installer" it
 * "downloads" records the environment it was given and puts a stand-in for
 * the tool where the vendor's installer would. No vendor is contacted and no
 * real tool is installed or started.
 */
const HELPER = fileURLToPath(new URL('../../../docker/install-cli.sh', import.meta.url));
// A shell script: Linux and macOS. The helper refuses to run as root.
const runnable = process.platform !== 'win32' && process.getuid?.() !== 0;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(tool: string, executable: string, environment: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'answerwall-install-helper-'));
  dirs.push(dir);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  const seen = path.join(dir, 'installer-environment');
  const started = path.join(dir, 'tool-was-started');
  const asked = path.join(dir, 'curl-arguments');
  // What the stand-in for curl "downloads": the installer.
  const installer = [
    `env > '${seen}'`,
    `mkdir -p "$(dirname "$HOME/${executable}")"`,
    `printf '#!/bin/sh\\ntouch "${started}"\\necho 9.9.9\\n' > "$HOME/${executable}"`,
    `chmod +x "$HOME/${executable}"`,
  ].join('\n');
  writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh\necho "$@" > '${asked}'\ncat <<'INSTALLER'\n${installer}\nINSTALLER\n`,
  );
  chmodSync(path.join(bin, 'curl'), 0o755);

  const result = spawnSync('bash', [HELPER, tool, '--yes'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      HOME: home,
      // The stand-in first. Should it ever be missed, the proxy below leads nowhere.
      PATH: `${bin}:/usr/bin:/bin`,
      ...environment,
    },
  });
  const installerEnv = existsSync(seen)
    ? Object.fromEntries(
        readFileSync(seen, 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      )
    : undefined;
  return {
    result,
    home,
    installerEnv,
    curlArguments: existsSync(asked) ? readFileSync(asked, 'utf8').trim() : undefined,
    toolWasStarted: existsSync(started),
  };
}

const NOWHERE = 'http://127.0.0.1:9';

describe.runIf(runnable)('the install helper of the container', () => {
  test('the installer of one vendor sees no secret of the service, its own or another vendor’s', () => {
    const { result, installerEnv, curlArguments, home } = install('grok', '.grok/bin/grok', {
      // What a service that followed the documentation can have in its environment.
      ANSWERWALL_TOKEN: 'static-token',
      ANSWERWALL_SECRET_PROVIDER_HOME_API_KEY: 'endpoint-key',
      GEMINI_API_KEY: 'google-key',
      OPENAI_API_KEY: 'openai-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      AWS_SECRET_ACCESS_KEY: 'something-else-entirely',
      TERM: 'xterm',
      LANG: 'C.UTF-8',
      https_proxy: NOWHERE,
      HTTPS_PROXY: NOWHERE,
      NO_PROXY: 'localhost',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(curlArguments).toBe('-fsSL https://x.ai/cli/install.sh');
    expect(installerEnv).toBeDefined();
    const names = Object.keys(installerEnv ?? {});
    // Everything it got is on the short list (plus what the shell sets by itself).
    const fromShell = ['PWD', 'SHLVL', '_', 'OLDPWD'];
    expect(names.filter((name) => !fromShell.includes(name)).sort()).toEqual(
      ['HOME', 'HTTPS_PROXY', 'LANG', 'NO_PROXY', 'PATH', 'TERM', 'https_proxy'].sort(),
    );
    expect(JSON.stringify(installerEnv)).not.toMatch(/-key|-token|something-else/);
    expect(installerEnv).toMatchObject({ HOME: home, https_proxy: NOWHERE, TERM: 'xterm' });
    // It says which variables it passed, by name.
    expect(result.stdout).toContain(
      'Environment variables passed to it: HOME PATH TERM LANG HTTPS_PROXY NO_PROXY https_proxy',
    );
    expect(result.stdout + result.stderr).not.toMatch(/google-key|static-token/);
  });

  test('the installed tool is not started, not even for its version', () => {
    const { result, toolWasStarted, home } = install('claude', '.local/bin/claude', {
      https_proxy: NOWHERE,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(home, '.local/bin/claude'))).toBe(true);
    expect(toolWasStarted).toBe(false);
    expect(result.stdout).toContain(`Installed: ${home}/.local/bin/claude`);
    expect(result.stdout).toContain('Press Refresh on the providers page');
    expect(result.stdout).not.toContain('9.9.9');
    // Signing in stays the user's own step.
    expect(result.stdout).toContain('docker exec -it <container> claude auth login');
  });

  test('an installer that leaves no executable where it should is reported', () => {
    const { result, toolWasStarted } = install('codex', 'somewhere/else/codex', {
      https_proxy: NOWHERE,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
    expect(toolWasStarted).toBe(false);
  });

  test('says before anything runs which variables an installer gets', () => {
    const help = spawnSync('bash', [HELPER, '--help'], {
      encoding: 'utf8',
      env: { HOME: tmpdir(), PATH: '/usr/bin:/bin', GEMINI_API_KEY: 'google-key' },
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('gets these environment variables');
    expect(help.stdout).toMatch(/HOME PATH .*TERM/);
    expect(help.stdout).toMatch(/https_proxy/);
    expect(help.stdout).not.toMatch(/GEMINI|ANSWERWALL_TOKEN/);
  });
});
