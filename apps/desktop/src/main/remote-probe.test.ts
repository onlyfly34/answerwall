import { describe, expect, test } from 'vitest';
import { API_VERSION, BRAND } from '@answerwall/core/protocol';
import type { Meta } from '@answerwall/core/protocol';
import { classifyFetchFailure, probeRemote } from './remote-probe.ts';
import type { MetaFetch, ProbeDeps } from './remote-probe.ts';

const meta: Meta = {
  name: BRAND.name,
  version: '1.2.3',
  apiVersion: API_VERSION,
  mode: 'server',
  tls: 'cert',
  authRequired: true,
};

function deps(answer: MetaFetch | Meta | string, appVersion = '1.2.3') {
  const requested: string[] = [];
  const probe: ProbeDeps = {
    resolve: async () => ['192.168.1.9'],
    appVersion,
    async fetchMeta(url) {
      requested.push(url);
      if (typeof answer === 'string') return { ok: true, status: 200, body: answer };
      if ('ok' in answer) return answer;
      return { ok: true, status: 200, body: JSON.stringify(answer) };
    },
  };
  return { probe, requested };
}

describe('probeRemote', () => {
  test('a matching server is accepted and described', async () => {
    const { probe, requested } = deps(meta);

    expect(await probeRemote('https://wall.example.com/', probe)).toEqual({
      ok: true,
      server: {
        origin: 'https://wall.example.com',
        insecure: false,
        name: BRAND.name,
        version: '1.2.3',
        apiVersion: API_VERSION,
        apiMismatch: false,
        versionMismatch: false,
      },
    });
    expect(requested).toEqual(['https://wall.example.com/api/meta']);
  });

  test('a server of another release or protocol version is accepted and flagged', async () => {
    const newer = deps({ ...meta, version: '2.0.0', apiVersion: API_VERSION + 1 });

    expect(await probeRemote('https://wall.example.com', newer.probe)).toMatchObject({
      ok: true,
      server: { version: '2.0.0', apiMismatch: true, versionMismatch: true },
    });
  });

  test('plain http to a private address is accepted and marked insecure', async () => {
    const { probe, requested } = deps(meta);

    expect(await probeRemote('http://nas.lan:7717', probe)).toMatchObject({
      ok: true,
      server: { origin: 'http://nas.lan:7717', insecure: true },
    });
    expect(requested).toEqual(['http://nas.lan:7717/api/meta']);
  });

  test('an address that is refused is never requested', async () => {
    const { probe, requested } = deps(meta);

    expect(await probeRemote('http://8.8.8.8', probe)).toEqual({
      ok: false,
      problem: { kind: 'url', detail: 'insecure_public' },
    });
    expect(await probeRemote('https://wall.example.com/path', probe)).toEqual({
      ok: false,
      problem: { kind: 'url', detail: 'path' },
    });
    expect(requested).toEqual([]);
  });

  test.each([
    ['not JSON', '<html>hello</html>'],
    ['JSON of another shape', '{"status":"ok"}'],
    ['another product', JSON.stringify({ ...meta, name: 'SomethingElse' })],
    ['an oversized body', JSON.stringify({ ...meta, padding: 'x'.repeat(70_000) })],
  ])('%s is not a server', async (_what, body) => {
    expect(await probeRemote('https://wall.example.com', deps(body).probe)).toEqual({
      ok: false,
      problem: { kind: 'not_a_server' },
    });
  });

  test('an error status is not a server', async () => {
    const { probe } = deps({ ok: true, status: 404, body: JSON.stringify(meta) });

    expect(await probeRemote('https://wall.example.com', probe)).toEqual({
      ok: false,
      problem: { kind: 'not_a_server' },
    });
  });

  test('another computer’s desktop app is refused', async () => {
    expect(
      await probeRemote('http://192.168.1.9:41873', deps({ ...meta, mode: 'desktop' }).probe),
    ).toEqual({ ok: false, problem: { kind: 'desktop_instance' } });
  });

  test('failures of the request are told apart', async () => {
    const failing = (error: string, timedOut = false) =>
      probeRemote('https://wall.example.com', deps({ ok: false, error, timedOut }).probe);

    expect(await failing('net::ERR_CONNECTION_REFUSED')).toEqual({
      ok: false,
      problem: { kind: 'unreachable' },
    });
    expect(await failing('net::ERR_CERT_AUTHORITY_INVALID')).toEqual({
      ok: false,
      problem: { kind: 'certificate' },
    });
    expect(await failing('This operation was aborted', true)).toEqual({
      ok: false,
      problem: { kind: 'timeout' },
    });
  });
});

describe('classifyFetchFailure', () => {
  test.each([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_COMMON_NAME_INVALID',
    'net::ERR_CERT_DATE_INVALID',
    'net::ERR_SSL_SERVER_CERT_BAD_FORMAT',
    'ERR_CERT_REVOKED (-206)',
  ])('%s is a certificate problem', (error) => {
    expect(classifyFetchFailure({ error, timedOut: false })).toEqual({ kind: 'certificate' });
  });

  test.each([
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_SSL_PROTOCOL_ERROR',
    'net::ERR_INTERNET_DISCONNECTED',
    'Redirect was cancelled',
    '',
  ])('%s is an unreachable server', (error) => {
    expect(classifyFetchFailure({ error, timedOut: false })).toEqual({ kind: 'unreachable' });
  });
});
