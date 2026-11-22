import { describe, expect, test } from 'vitest';
import { BRAND } from '@answerwall/core';
import type { AppConfig } from '@answerwall/core';
import { createTestConfig } from '@answerwall/core/testing';
import { startupLines } from './banner.ts';

const TOKEN = 'automation-token-0123456789';
const WEB = { webRoot: 'web' };

const lines = (config: Partial<AppConfig>, port = 7717) => {
  const full = createTestConfig({ ...WEB, ...config });
  const host = full.host.includes(':') ? `[${full.host}]` : full.host;
  const scheme = full.tls.mode === 'off' ? 'http' : 'https';
  return startupLines(full, { port, url: `${scheme}://${host}:${port}` });
};
const warnings = (config: Partial<AppConfig>): string[] =>
  lines(config)
    .filter((line) => line.level === 'warn')
    .map((line) => line.message);

describe('startup banner', () => {
  test('a default start shows the local URL and no warning', () => {
    expect(lines({ version: '1.2.3' })).toEqual([
      {
        level: 'info',
        message: `${BRAND.name} 1.2.3 is listening`,
        fields: { url: 'http://localhost:7717', tls: 'off' },
      },
    ]);
  });

  test('a wildcard bind is shown as localhost, with the public origins next to it', () => {
    const [first] = lines({
      host: '0.0.0.0',
      tls: { mode: 'auto', hostnames: ['nas.local'] },
      publicOrigins: ['https://nas.local:7717'],
    });
    expect(first?.fields).toEqual({
      url: 'https://localhost:7717',
      publicOrigins: ['https://nas.local:7717'],
      tls: 'auto',
    });
  });

  test('a specific bind address is shown as it is', () => {
    const [first] = lines({ host: '192.168.1.10', allowInsecure: true });
    expect(first?.fields?.['url']).toBe('http://192.168.1.10:7717');
  });

  test('insecure mode is announced loudly', () => {
    const [warning] = warnings({
      host: '0.0.0.0',
      allowInsecure: true,
      publicOrigins: ['http://nas.local:7717'],
    });
    expect(warning).toMatch(/^INSECURE MODE: plain HTTP is accepted from other machines/);
    expect(warning).toContain(`${BRAND.envPrefix}ALLOW_INSECURE`);
  });

  test('plain HTTP beyond loopback without a proxy explains why nobody can connect', () => {
    expect(warnings({ host: '0.0.0.0', publicOrigins: ['https://wall.example.com'] })).toEqual([
      expect.stringMatching(/connections from other machines are refused.*TRUSTED_PROXIES/),
    ]);
  });

  test('the reverse-proxy setup is quiet', () => {
    expect(
      warnings({
        host: '0.0.0.0',
        trustedProxies: ['172.18.0.0/16'],
        publicOrigins: ['https://wall.example.com'],
      }),
    ).toEqual([]);
  });

  test('a network bind without any public origin says browsers will be refused', () => {
    expect(warnings({ host: '0.0.0.0', tls: { mode: 'auto', hostnames: [] } })).toEqual([
      expect.stringContaining(`${BRAND.envPrefix}PUBLIC_ORIGINS`),
    ]);
  });

  test('allow-insecure on loopback is pointed out as pointless', () => {
    expect(warnings({ allowInsecure: true })).toEqual([expect.stringContaining('has no effect')]);
  });

  test('trusted proxies together with TLS are pointed out', () => {
    expect(
      warnings({
        tls: { mode: 'cert', certFile: 'c', keyFile: 'k' },
        trustedProxies: ['10.0.0.2'],
      }),
    ).toEqual([expect.stringContaining('forwarded headers are still honoured')]);
  });

  test('a missing web UI is pointed out', () => {
    const full = createTestConfig();
    const messages = startupLines(full, { port: 1, url: 'http://127.0.0.1:1' }).map(
      (line) => line.message,
    );
    expect(messages).toContainEqual(expect.stringContaining('only the API is served'));
  });

  test('a static token is mentioned but never shown', () => {
    const all = lines({ staticToken: TOKEN });
    expect(all.at(-1)).toEqual({
      level: 'info',
      message: expect.stringContaining(`${BRAND.envPrefix}TOKEN`) as string,
    });
    expect(JSON.stringify(all)).not.toContain(TOKEN);
  });
});
