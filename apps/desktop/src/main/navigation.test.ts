import { describe, expect, test } from 'vitest';
import {
  allowsLocalRequest,
  allowsNavigation,
  isSameOrigin,
  windowOpenAction,
} from './navigation.ts';
import type { Confinement } from './navigation.ts';

const LOCAL = 'http://127.0.0.1:41873';
const local: Confinement = { kind: 'origin', origin: LOCAL };
const remote: Confinement = { kind: 'origin', origin: 'https://wall.example.com' };
const page: Confinement = {
  kind: 'file',
  url: 'file:///C:/Program%20Files/App/resources/app.asar/dist/connection/index.html',
};

describe('isSameOrigin', () => {
  test('needs the same scheme, host and port', () => {
    expect(isSameOrigin(`${LOCAL}/history?q=1#top`, LOCAL)).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:41874/', LOCAL)).toBe(false);
    expect(isSameOrigin('https://127.0.0.1:41873/', LOCAL)).toBe(false);
    expect(isSameOrigin('http://localhost:41873/', LOCAL)).toBe(false);
    expect(isSameOrigin('http://127.0.0.1/', LOCAL)).toBe(false);
  });

  test('a look-alike host is another origin', () => {
    expect(isSameOrigin('http://127.0.0.1:41873.evil.example/', LOCAL)).toBe(false);
    expect(isSameOrigin('http://127.0.0.1:41873@evil.example/', LOCAL)).toBe(false);
    expect(isSameOrigin('https://wall.example.com.evil.example/', remote.origin)).toBe(false);
  });

  test('nothing but http and https has a web origin here', () => {
    expect(isSameOrigin('file:///etc/passwd', LOCAL)).toBe(false);
    expect(isSameOrigin('javascript:alert(1)', LOCAL)).toBe(false);
    expect(isSameOrigin('not a url', LOCAL)).toBe(false);
    expect(isSameOrigin('', LOCAL)).toBe(false);
  });
});

describe('allowsNavigation', () => {
  test('a window stays on its own origin', () => {
    expect(allowsNavigation(`${LOCAL}/providers`, local)).toBe(true);
    expect(allowsNavigation('https://wall.example.com/settings', remote)).toBe(true);
  });

  test.each([
    'https://example.com/',
    'http://127.0.0.1:9/',
    'http://wall.example.com/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/1',
    'about:blank',
    'chrome://settings',
    'ms-settings:privacy',
  ])('leaving for %s is refused', (target) => {
    expect(allowsNavigation(target, local)).toBe(false);
    expect(allowsNavigation(target, remote)).toBe(false);
    expect(allowsNavigation(target, page)).toBe(false);
  });

  test('the local and the remote window cannot reach each other', () => {
    expect(allowsNavigation('https://wall.example.com/', local)).toBe(false);
    expect(allowsNavigation(`${LOCAL}/`, remote)).toBe(false);
  });

  test('the connection page may only move within itself', () => {
    expect(allowsNavigation(page.url, page)).toBe(true);
    expect(allowsNavigation(`${page.url}#remote`, page)).toBe(true);
    expect(allowsNavigation(`${page.url}?x=1`, page)).toBe(false);
    expect(
      allowsNavigation(
        'file:///C:/Program%20Files/App/resources/app.asar/dist/connection/other.html',
        page,
      ),
    ).toBe(false);
    expect(allowsNavigation(`${LOCAL}/`, page)).toBe(false);
  });
});

describe('windowOpenAction', () => {
  test('web links to elsewhere go to the system browser', () => {
    expect(windowOpenAction('https://example.com/docs', local)).toBe('external');
    expect(windowOpenAction('http://example.com/', remote)).toBe('external');
    expect(windowOpenAction('https://example.com/', page)).toBe('external');
  });

  test('the app’s own pages are not opened outside it', () => {
    expect(windowOpenAction(`${LOCAL}/history`, local)).toBe('drop');
    expect(windowOpenAction('https://wall.example.com/history', remote)).toBe('drop');
  });

  test.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
    'smb://server/share',
    'about:blank',
    'https://user:secret@example.com/',
    'not a url',
    '',
  ])('%s is never handed to the system', (target) => {
    expect(windowOpenAction(target, local)).toBe('drop');
    expect(windowOpenAction(target, remote)).toBe('drop');
  });
});

describe('allowsLocalRequest', () => {
  test('the local window’s session reaches its own server only', () => {
    expect(allowsLocalRequest(`${LOCAL}/api/ask`, LOCAL)).toBe(true);
    expect(allowsLocalRequest('http://127.0.0.1:41874/api/ask', LOCAL)).toBe(false);
    expect(allowsLocalRequest('https://example.com/pixel.gif', LOCAL)).toBe(false);
    expect(allowsLocalRequest('wss://example.com/socket', LOCAL)).toBe(false);
    expect(allowsLocalRequest('ws://127.0.0.1:41873/socket', LOCAL)).toBe(false);
  });

  test('what is not a network request is left alone', () => {
    expect(allowsLocalRequest('data:image/png;base64,AAAA', LOCAL)).toBe(true);
    expect(allowsLocalRequest('blob:http://127.0.0.1:41873/1', LOCAL)).toBe(true);
    expect(allowsLocalRequest('devtools://devtools/bundled/x.js', LOCAL)).toBe(true);
    expect(allowsLocalRequest('not a url', LOCAL)).toBe(false);
  });
});
