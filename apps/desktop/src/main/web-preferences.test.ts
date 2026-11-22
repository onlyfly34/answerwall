import type { Session } from 'electron';
import { describe, expect, test } from 'vitest';
import { lockedWebPreferences } from './web-preferences.ts';

const session = {} as Session;

describe('lockedWebPreferences', () => {
  test('every window is isolated, sandboxed and without Node', () => {
    for (const preload of [undefined, '/app/dist/preload-local.cjs']) {
      expect(lockedWebPreferences({ session, preload, devTools: false })).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        devTools: false,
      });
    }
  });

  test('a window has a preload only when it is given one', () => {
    expect(lockedWebPreferences({ session, devTools: false })).not.toHaveProperty('preload');
    expect(lockedWebPreferences({ session, preload: '/p.cjs', devTools: true })).toMatchObject({
      preload: '/p.cjs',
      devTools: true,
    });
  });

  test('uses the session it was given', () => {
    expect(lockedWebPreferences({ session, devTools: false }).session).toBe(session);
  });
});
