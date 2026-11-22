import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BRAND, SECRET_KEYS, secretEnvName } from '@answerwall/core';
import type { AppConfig } from '@answerwall/core';
import { ConfigError, loadConfig, loadSettings, OPTIONS } from './config.ts';

const env = (values: Record<string, string>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => [BRAND.envPrefix + name, value]),
  );

const TOKEN = 'automation-token-0123456789';

function failure(values: Record<string, string>): string {
  try {
    loadConfig(env(values));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be refused');
}

let webRoot: string;
let emptyDir: string;

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'config-web-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html>');
  emptyDir = await mkdtemp(join(tmpdir(), 'config-empty-'));
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
});

describe('defaults', () => {
  test('loopback, the default port, TLS off, no token, info logging', () => {
    const { config, logFormat } = loadSettings({ PATH: '/usr/bin', HOME: '/home/someone' });

    expect(config).toMatchObject({
      mode: 'server',
      host: '127.0.0.1',
      port: BRAND.defaultPort,
      publicOrigins: [],
      trustedProxies: [],
      tls: { mode: 'off' },
      allowInsecure: false,
      logLevel: 'info',
    } satisfies Partial<AppConfig>);
    expect(config.staticToken).toBeUndefined();
    expect(config.dataDir).toBe(join(homedir(), `.${BRAND.slug}`));
    expect(config.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(logFormat).toBeUndefined();
  });

  test('an empty value counts as not set', () => {
    const config = loadConfig(env({ HOST: '', PORT: ' ', TLS: '', TOKEN: '', ALLOW_INSECURE: '' }));
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: BRAND.defaultPort,
      tls: { mode: 'off' },
    });
    expect(config.staticToken).toBeUndefined();
  });
});

describe('every option is read', () => {
  test.each<[Record<string, string>, Partial<AppConfig>]>([
    [{ HOST: '0.0.0.0' }, { host: '0.0.0.0' }],
    [{ HOST: '::' }, { host: '::' }],
    [{ HOST: '[::1]' }, { host: '::1' }],
    [{ HOST: '0:0:0:0:0:0:0:1' }, { host: '::1' }],
    [{ HOST: 'LocalHost' }, { host: 'localhost' }],
    [{ PORT: '0' }, { port: 0 }],
    [{ PORT: '65535' }, { port: 65535 }],
    [{ ALLOW_INSECURE: '1' }, { allowInsecure: true }],
    [{ ALLOW_INSECURE: 'TRUE' }, { allowInsecure: true }],
    [{ ALLOW_INSECURE: '0' }, { allowInsecure: false }],
    [{ ALLOW_INSECURE: 'off' }, { allowInsecure: false }],
    [{ TOKEN }, { staticToken: TOKEN }],
    [{ LOG_LEVEL: 'debug' }, { logLevel: 'debug' }],
    [{ LOG_LEVEL: 'ERROR' }, { logLevel: 'error' }],
    [
      { TRUSTED_PROXIES: '10.0.0.2, 172.18.0.0/16 ,fd00::/8,::1, 10.0.0.2' },
      { trustedProxies: ['10.0.0.2', '172.18.0.0/16', 'fd00::/8', '::1'] },
    ],
    [
      {
        PUBLIC_ORIGINS:
          'https://Wall.Example.com/, http://nas.local:8080,https://wall.example.com:443',
      },
      { publicOrigins: ['https://wall.example.com', 'http://nas.local:8080'] },
    ],
    [
      { PUBLIC_ORIGINS: 'https://[2001:DB8::1]:8443' },
      { publicOrigins: ['https://[2001:db8::1]:8443'] },
    ],
    [{ TLS: 'off' }, { tls: { mode: 'off' } }],
    [{ TLS: 'AUTO' }, { tls: { mode: 'auto', hostnames: [] } }],
    [
      { TLS: 'auto', TLS_HOSTNAMES: 'NAS.local, 192.168.1.10,[fd00::5], *.home.arpa' },
      { tls: { mode: 'auto', hostnames: ['nas.local', '192.168.1.10', 'fd00::5', '*.home.arpa'] } },
    ],
  ])('%j', (values, expected) => {
    expect(loadConfig(env(values))).toMatchObject(expected);
  });

  test('the data directory is made absolute', () => {
    const config = loadConfig(env({ DATA_DIR: 'somewhere/data' }));
    expect(isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir).toBe(resolve('somewhere/data'));
  });

  test('certificate files are made absolute', () => {
    const config = loadConfig(
      env({ TLS: 'cert', TLS_CERT: 'tls/fullchain.pem', TLS_KEY: 'tls/key.pem' }),
    );
    expect(config.tls).toEqual({
      mode: 'cert',
      certFile: resolve('tls/fullchain.pem'),
      keyFile: resolve('tls/key.pem'),
    });
  });

  test('the log format is json, text or left to the caller', () => {
    expect(loadSettings(env({ LOG_FORMAT: 'json' })).logFormat).toBe('json');
    expect(loadSettings(env({ LOG_FORMAT: 'Text' })).logFormat).toBe('text');
  });

  test('a web root with an index.html is used', () => {
    expect(loadConfig(env({ WEB_ROOT: webRoot })).webRoot).toBe(webRoot);
  });

  test('the table of options covers exactly what is parsed', () => {
    const everything = env({
      HOST: '0.0.0.0',
      PORT: '8443',
      DATA_DIR: 'data',
      WEB_ROOT: webRoot,
      PUBLIC_ORIGINS: 'https://wall.example.com',
      TRUSTED_PROXIES: '10.0.0.2',
      TLS: 'auto',
      TLS_HOSTNAMES: 'wall.example.com',
      ALLOW_INSECURE: '0',
      TOKEN,
      LOG_LEVEL: 'warn',
      LOG_FORMAT: 'json',
    });
    expect(() => loadConfig(everything)).not.toThrow();
    const names = OPTIONS.map((option) => option.name);
    expect(Object.keys(everything).map((name) => name.slice(BRAND.envPrefix.length))).toEqual(
      names.filter((name) => name !== 'TLS_CERT' && name !== 'TLS_KEY'),
    );
  });

  test('the token has no command-line flag: it would show in the process list', () => {
    expect(OPTIONS.find((option) => option.name === 'TOKEN')).not.toHaveProperty('flag');
  });
});

describe('invalid values are refused with the name of the variable', () => {
  test.each<[Record<string, string>, RegExp]>([
    [{ PORT: 'eighty' }, /ANSWERWALL_PORT must be a port number/],
    [{ PORT: '-1' }, /ANSWERWALL_PORT/],
    [{ PORT: '65536' }, /ANSWERWALL_PORT/],
    [{ PORT: '80.5' }, /ANSWERWALL_PORT/],
    [{ PORT: '0x50' }, /ANSWERWALL_PORT/],
    [{ HOST: 'http://localhost' }, /ANSWERWALL_HOST must be an IP address or a host name/],
    [{ HOST: 'local host' }, /ANSWERWALL_HOST/],
    [{ HOST: '127.0.0.1:8080' }, /ANSWERWALL_HOST/],
    [{ ALLOW_INSECURE: 'maybe' }, /ANSWERWALL_ALLOW_INSECURE must be 1 or 0/],
    [{ LOG_LEVEL: 'verbose' }, /ANSWERWALL_LOG_LEVEL must be one of: debug, info, warn, error/],
    [{ LOG_FORMAT: 'xml' }, /ANSWERWALL_LOG_FORMAT must be one of: json, text/],
    [{ TLS: 'on' }, /ANSWERWALL_TLS must be one of: off, cert, auto/],
    [{ TLS: 'cert' }, /ANSWERWALL_TLS=cert needs both ANSWERWALL_TLS_CERT and ANSWERWALL_TLS_KEY/],
    [{ TLS: 'cert', TLS_CERT: 'c.pem' }, /needs both/],
    [{ TLS: 'cert', TLS_KEY: 'k.pem' }, /needs both/],
    [{ TLS_CERT: 'c.pem', TLS_KEY: 'k.pem' }, /used only with ANSWERWALL_TLS=cert/],
    [{ TLS: 'auto', TLS_CERT: 'c.pem' }, /used only with ANSWERWALL_TLS=cert/],
    [
      { TLS_HOSTNAMES: 'nas.local' },
      /ANSWERWALL_TLS_HOSTNAMES is used only with ANSWERWALL_TLS=auto/,
    ],
    [
      { TLS: 'auto', TLS_HOSTNAMES: 'https://nas.local' },
      /"https:\/\/nas.local" is not a DNS name/,
    ],
    [{ TLS: 'auto', TLS_HOSTNAMES: 'nas.local:8443' }, /ANSWERWALL_TLS_HOSTNAMES/],
    [{ TLS: 'auto', TLS_HOSTNAMES: 'bad_name' }, /ANSWERWALL_TLS_HOSTNAMES/],
    [
      { PUBLIC_ORIGINS: 'wall.example.com' },
      /ANSWERWALL_PUBLIC_ORIGINS: "wall.example.com" is not an origin/,
    ],
    [{ PUBLIC_ORIGINS: 'https://wall.example.com/app' }, /not an origin/],
    [{ PUBLIC_ORIGINS: 'https://wall.example.com?x=1' }, /not an origin/],
    [{ PUBLIC_ORIGINS: 'https://wall.example.com/#top' }, /not an origin/],
    [{ PUBLIC_ORIGINS: 'https://user:pw@wall.example.com' }, /not an origin/],
    [{ PUBLIC_ORIGINS: 'ftp://wall.example.com' }, /not an origin/],
    [{ PUBLIC_ORIGINS: 'https://ok.example.com, *' }, /"\*" is not an origin/],
    [
      { TRUSTED_PROXIES: 'proxy.internal' },
      /ANSWERWALL_TRUSTED_PROXIES: "proxy.internal" is not an IP address or CIDR range/,
    ],
    [{ TRUSTED_PROXIES: '10.0.0.0/33' }, /ANSWERWALL_TRUSTED_PROXIES/],
    [{ TRUSTED_PROXIES: '10.0.0.0/8/8' }, /ANSWERWALL_TRUSTED_PROXIES/],
    [{ TRUSTED_PROXIES: '10.0.0.0/' }, /ANSWERWALL_TRUSTED_PROXIES/],
    [{ TRUSTED_PROXIES: 'fd00::/129' }, /ANSWERWALL_TRUSTED_PROXIES/],
    [{ TRUSTED_PROXIES: '10.0.0.2 10.0.0.3' }, /ANSWERWALL_TRUSTED_PROXIES/],
    [{ WEB_ROOT: 'does/not/exist' }, /ANSWERWALL_WEB_ROOT does not contain an index.html/],
  ])('%j', (values, message) => {
    expect(failure(values)).toMatch(message);
  });

  test('a web root without an index.html is refused', () => {
    expect(failure({ WEB_ROOT: emptyDir })).toMatch(/ANSWERWALL_WEB_ROOT/);
  });

  test.each([
    ['too short', 'short-token'],
    ['too long', 'x'.repeat(513)],
    ['with a space', 'token with spaces inside it'],
    ['with a line break', 'token-0123456789abcdef\nX-Injected: 1'],
    ['not ASCII', 'tökén-0123456789abcdef'],
  ])('a static token that is %s is refused without repeating it', (_label, token) => {
    const message = failure({ TOKEN: token });
    expect(message).toMatch(/ANSWERWALL_TOKEN must be 16 to 512 visible ASCII characters/);
    expect(message).not.toContain(token);
    expect(message).not.toContain(token.slice(0, 8));
  });
});

describe('unknown variables', () => {
  test('a misspelt or unsupported variable is refused instead of ignored', () => {
    const message = failure({ PUBLIC_ORIGIN: 'https://wall.example.com', TLS_MODE: 'auto' });
    expect(message).toMatch(/^Unknown settings: ANSWERWALL_PUBLIC_ORIGIN, ANSWERWALL_TLS_MODE\./);
    expect(message).toContain('ANSWERWALL_PUBLIC_ORIGINS');
    expect(message).not.toContain('wall.example.com');
  });

  test('even when its value is empty', () => {
    expect(failure({ AUTH: '' })).toMatch(/Unknown setting: ANSWERWALL_AUTH\./);
  });

  test('there is no switch that turns authentication off', () => {
    for (const name of ['AUTH', 'NO_AUTH', 'DISABLE_AUTH', 'AUTH_DISABLED', 'INSECURE_NO_AUTH']) {
      expect(failure({ [name]: '0' })).toMatch(/Unknown setting/);
    }
  });

  test('secret overlay variables are left to the secret store', () => {
    const name = secretEnvName(SECRET_KEYS.providerApiKey('my-endpoint'));
    expect(name).toBe(`${BRAND.envPrefix}SECRET_PROVIDER_MY_ENDPOINT_API_KEY`);
    expect(loadConfig({ [name]: 'sk-value' }).port).toBe(BRAND.defaultPort);
  });

  test('variables of other programs are ignored', () => {
    expect(() =>
      loadConfig({ PATH: '/usr/bin', ANSWERWALLX: '1', MY_ANSWERWALL_PORT: 'x' }),
    ).not.toThrow();
  });
});

describe('command-line overrides', () => {
  test('win over the environment', () => {
    const config = loadConfig(env({ PORT: '8000', HOST: '0.0.0.0', LOG_LEVEL: 'warn' }), {
      PORT: '9000',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({ port: 9000, host: '0.0.0.0', logLevel: 'debug' });
  });

  test('are validated like the environment', () => {
    expect(() => loadConfig({}, { PORT: 'x' })).toThrow(/ANSWERWALL_PORT/);
  });
});

describe('derived names', () => {
  test('auto TLS issues for the https public origins and the bind address', () => {
    const config = loadConfig(
      env({
        TLS: 'auto',
        HOST: '192.168.1.10',
        PUBLIC_ORIGINS: 'https://nas.local:8443,https://[fd00::5],http://plain.local',
      }),
    );
    expect(config.tls).toEqual({
      mode: 'auto',
      hostnames: ['nas.local', 'fd00::5', '192.168.1.10'],
    });
    expect(config.publicOrigins).toEqual([
      'https://nas.local:8443',
      'https://[fd00::5]',
      'http://plain.local',
    ]);
  });

  test('explicit TLS host names replace the derived ones', () => {
    const config = loadConfig(
      env({ TLS: 'auto', TLS_HOSTNAMES: 'wall.lan', PUBLIC_ORIGINS: 'https://nas.local' }),
    );
    expect(config.tls).toEqual({ mode: 'auto', hostnames: ['wall.lan'] });
  });

  test('without public origins, the certificate names are allowed on the server port', () => {
    const config = loadConfig(
      env({
        TLS: 'auto',
        HOST: '0.0.0.0',
        PORT: '8443',
        TLS_HOSTNAMES: 'nas.local,192.168.1.10,fd00::5,*.lan,localhost',
      }),
    );
    expect(config.publicOrigins).toEqual([
      'https://nas.local:8443',
      'https://192.168.1.10:8443',
      'https://[fd00::5]:8443',
    ]);
  });

  test('a specific bind address is an allowed origin on its own', () => {
    expect(loadConfig(env({ HOST: '192.168.1.10', ALLOW_INSECURE: '1' })).publicOrigins).toEqual([
      `http://192.168.1.10:${BRAND.defaultPort}`,
    ]);
    expect(
      loadConfig(env({ HOST: 'fd00::5', PORT: '80', ALLOW_INSECURE: '1' })).publicOrigins,
    ).toEqual(['http://[fd00::5]']);
  });

  test.each([
    { HOST: '0.0.0.0' },
    { HOST: '::' },
    { HOST: '127.0.0.1' },
    { HOST: 'localhost' },
    { HOST: '::1' },
  ])('nothing is derived for %j', (values) => {
    expect(loadConfig(env(values)).publicOrigins).toEqual([]);
  });

  test('nothing is derived when the port is picked at start or origins are given', () => {
    expect(loadConfig(env({ HOST: '192.168.1.10', PORT: '0' })).publicOrigins).toEqual([]);
    expect(
      loadConfig(env({ HOST: '192.168.1.10', PUBLIC_ORIGINS: 'https://wall.example.com' }))
        .publicOrigins,
    ).toEqual(['https://wall.example.com']);
  });
});
