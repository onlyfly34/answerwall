import { describe, expect, test } from 'vitest';
import { authorizedHeaders } from './auth-header.ts';
import type { LocalGrant } from './auth-header.ts';

const grant: LocalGrant = {
  origin: 'http://127.0.0.1:41873',
  token: 'launch-token-0123456789abcdef',
};
const BEARER = `Bearer ${grant.token}`;

describe('authorizedHeaders', () => {
  test('adds the token to requests for the local server', () => {
    expect(
      authorizedHeaders('http://127.0.0.1:41873/api/settings', { Accept: '*/*' }, grant),
    ).toEqual({ Accept: '*/*', Authorization: BEARER });
    expect(authorizedHeaders('http://127.0.0.1:41873/', {}, grant)).toEqual({
      Authorization: BEARER,
    });
  });

  test('replaces whatever the page set, in any spelling', () => {
    expect(
      authorizedHeaders(
        'http://127.0.0.1:41873/api/ask',
        { authorization: 'Bearer from-the-page', AUTHORIZATION: 'Basic eDp5' },
        grant,
      ),
    ).toEqual({ Authorization: BEARER });
  });

  test.each([
    'http://127.0.0.1:41874/api/settings',
    'http://127.0.0.1/api/settings',
    'https://127.0.0.1:41873/api/settings',
    'http://localhost:41873/api/settings',
    'http://[::1]:41873/api/settings',
    'http://127.0.0.2:41873/',
    'http://127.0.0.1:41873.example.com/',
    'http://127.0.0.1:41873@example.com/',
    'http://example.com/?next=http://127.0.0.1:41873/',
    'https://wall.example.com/api/settings',
    'ws://127.0.0.1:41873/socket',
    'file:///C:/Users/x/secrets.txt',
    'not a url',
  ])('the token is not sent to %s', (url) => {
    const headers = authorizedHeaders(url, { Accept: '*/*' }, grant);

    expect(headers).toEqual({ Accept: '*/*' });
    expect(JSON.stringify(headers)).not.toContain(grant.token);
  });

  test('other requests keep their own Authorization', () => {
    expect(
      authorizedHeaders('https://wall.example.com/api', { Authorization: 'Bearer theirs' }, grant),
    ).toEqual({ Authorization: 'Bearer theirs' });
  });

  test('the token is taken off a request that carries it elsewhere', () => {
    expect(
      authorizedHeaders(
        'https://example.com/redirected',
        { authorization: BEARER, Accept: '*/*' },
        grant,
      ),
    ).toEqual({ Accept: '*/*' });
  });

  test('the given headers are not changed', () => {
    const headers = { Accept: '*/*' };

    authorizedHeaders('http://127.0.0.1:41873/', headers, grant);

    expect(headers).toEqual({ Accept: '*/*' });
  });
});
