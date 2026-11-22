import { isAbsolute } from 'node:path';
import { expect, test } from 'vitest';
import { BRAND, SECRET_KEYS, secretEnvName } from '@answerwall/core';
import { loadConfig } from './config.ts';

const env = (values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => [BRAND.envPrefix + name, value]),
  );

test('defaults bind loopback on the default port with TLS off', () => {
  const config = loadConfig({ PATH: '/usr/bin' });
  expect(config).toMatchObject({
    mode: 'server',
    host: '127.0.0.1',
    port: BRAND.defaultPort,
    tls: { mode: 'off' },
    allowInsecure: false,
  });
  expect(isAbsolute(config.dataDir)).toBe(true);
  expect(config.version).toMatch(/^\d+\.\d+\.\d+/);
});

test('host, port and data dir come from the environment', () => {
  const config = loadConfig(env({ HOST: '0.0.0.0', PORT: '0', DATA_DIR: 'somewhere' }));
  expect(config).toMatchObject({ host: '0.0.0.0', port: 0 });
  expect(config.dataDir).toMatch(/somewhere$/);
});

test('an invalid port is refused', () => {
  expect(() => loadConfig(env({ PORT: 'eighty' }))).toThrow(/PORT/);
});

test('secret overlay variables are left to the secret store', () => {
  const name = secretEnvName(SECRET_KEYS.providerApiKey('my-endpoint'));
  expect(name).toBe(`${BRAND.envPrefix}SECRET_PROVIDER_MY_ENDPOINT_API_KEY`);
  expect(loadConfig({ [name]: 'sk-value' }).port).toBe(BRAND.defaultPort);
});

test('settings that are not implemented yet are refused instead of ignored', () => {
  expect(() => loadConfig(env({ TLS: 'auto' }))).toThrow(`${BRAND.envPrefix}TLS`);
});
