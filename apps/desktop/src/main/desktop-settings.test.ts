import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createDesktopSettingsStore,
  DEFAULT_DESKTOP_SETTINGS,
  repairDesktopSettings,
} from './desktop-settings.ts';
import type { SettingsFiles } from './desktop-settings.ts';

function memoryFiles(initial?: string): SettingsFiles & { content: string | undefined } {
  const files = {
    content: initial,
    read: () => files.content,
    write(_file: string, content: string) {
      files.content = content;
    },
  };
  return files;
}

describe('repairDesktopSettings', () => {
  test('nothing stored means nothing chosen', () => {
    for (const document of [undefined, null, 'local', 7, [], {}]) {
      expect(repairDesktopSettings(document)).toEqual(DEFAULT_DESKTOP_SETTINGS);
    }
    expect(DEFAULT_DESKTOP_SETTINGS).toMatchObject({ mode: undefined, updateCheck: true });
  });

  test('keeps what is well-formed', () => {
    expect(
      repairDesktopSettings({
        version: 1,
        mode: 'remote',
        remoteUrl: 'https://wall.example.com:7717',
        localPort: 41873,
        updateCheck: false,
        updateCheckPending: true,
      }),
    ).toEqual({
      mode: 'remote',
      remoteUrl: 'https://wall.example.com:7717',
      localPort: 41873,
      updateCheck: false,
      updateCheckPending: true,
    });
  });

  test('remote mode without a usable address is no choice at all', () => {
    expect(repairDesktopSettings({ mode: 'remote' }).mode).toBeUndefined();
    for (const remoteUrl of ['wall.example.com', 'https://wall.example.com/x', 'file:///x', 7]) {
      expect(repairDesktopSettings({ mode: 'remote', remoteUrl })).toMatchObject({
        mode: undefined,
        remoteUrl: undefined,
      });
    }
  });

  test('the remote address is kept while the mode is local', () => {
    expect(
      repairDesktopSettings({ mode: 'local', remoteUrl: 'http://10.0.0.5:7717' }),
    ).toMatchObject({ mode: 'local', remoteUrl: 'http://10.0.0.5:7717' });
  });

  test('drops what is malformed, field by field', () => {
    expect(
      repairDesktopSettings({
        mode: 'cloud',
        localPort: 80,
        updateCheck: 'no',
        updateCheckPending: 1,
      }),
    ).toEqual(DEFAULT_DESKTOP_SETTINGS);
    for (const localPort of [0, 1023, 65536, 4187.5, '41873', Number.NaN]) {
      expect(repairDesktopSettings({ localPort }).localPort).toBeUndefined();
    }
  });
});

describe('createDesktopSettingsStore', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('starts from the defaults when there is no file', () => {
    expect(createDesktopSettingsStore('settings.json', memoryFiles()).get()).toEqual(
      DEFAULT_DESKTOP_SETTINGS,
    );
  });

  test('a damaged file counts as none', () => {
    const store = createDesktopSettingsStore('settings.json', memoryFiles('{"mode": "lo'));

    expect(store.get()).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  test('an update changes only the given fields and is written at once', () => {
    const files = memoryFiles(JSON.stringify({ mode: 'local', localPort: 41873 }));
    const store = createDesktopSettingsStore('settings.json', files);

    const updated = store.update({ mode: 'remote', remoteUrl: 'https://wall.example.com' });

    expect(updated).toMatchObject({
      mode: 'remote',
      remoteUrl: 'https://wall.example.com',
      localPort: 41873,
    });
    expect(JSON.parse(files.content ?? '')).toMatchObject({
      version: 1,
      mode: 'remote',
      remoteUrl: 'https://wall.example.com',
      localPort: 41873,
    });
    expect(store.get()).toEqual(updated);
  });

  test('what an update would break is repaired before it is written', () => {
    const files = memoryFiles();
    const store = createDesktopSettingsStore('settings.json', files);

    store.update({ mode: 'remote', remoteUrl: 'not a url' });

    expect(store.get().mode).toBeUndefined();
    expect(JSON.parse(files.content ?? '')).not.toHaveProperty('mode');
  });

  test('the returned settings are copies', () => {
    const store = createDesktopSettingsStore('settings.json', memoryFiles());

    store.get().mode = 'local';

    expect(store.get().mode).toBeUndefined();
  });

  test('on disk: the choice survives a restart, in a directory that did not exist', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'desktop-settings-'));
    const file = path.join(dir, 'nested', 'desktop.json');

    createDesktopSettingsStore(file).update({ mode: 'local', localPort: 50123 });

    expect(createDesktopSettingsStore(file).get()).toMatchObject({
      mode: 'local',
      localPort: 50123,
    });
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  test('on disk: a file that is not JSON is replaced by the next update', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'desktop-settings-'));
    const file = path.join(dir, 'desktop.json');
    writeFileSync(file, 'garbage');

    const store = createDesktopSettingsStore(file);
    store.update({ updateCheck: false });

    expect(createDesktopSettingsStore(file).get().updateCheck).toBe(false);
  });
});
