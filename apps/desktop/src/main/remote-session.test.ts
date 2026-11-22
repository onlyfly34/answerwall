import { describe, expect, test } from 'vitest';
import { claimRemoteStore } from './remote-session.ts';
import type { RemoteStore } from './remote-session.ts';

function store(failing?: keyof RemoteStore): { calls: string[]; store: RemoteStore } {
  const calls: string[] = [];
  const step = (name: keyof RemoteStore) => async (): Promise<void> => {
    calls.push(name);
    if (name === failing) throw new Error('disk');
  };
  return {
    calls,
    store: {
      clearStorageData: step('clearStorageData'),
      clearCache: step('clearCache'),
      clearAuthCache: step('clearAuthCache'),
    },
  };
}

describe('claimRemoteStore', () => {
  test('another port of the same host is another server: nothing of the first one is kept', async () => {
    const { calls, store: remote } = store();

    expect(
      await claimRemoteStore(remote, 'http://host.example:7717', 'http://host.example:8080'),
    ).toBe(true);

    expect(calls).toEqual(['clearStorageData', 'clearCache', 'clearAuthCache']);
  });

  test.each([
    ['https://a.example', 'https://b.example'],
    ['http://a.example', 'https://a.example'],
    [undefined, 'https://a.example'],
  ])('clears when the saved server is %s and the new one %s', async (previous, next) => {
    const { calls, store: remote } = store();

    expect(await claimRemoteStore(remote, previous, next)).toBe(true);

    expect(calls).toContain('clearStorageData');
  });

  test('the same server keeps its pairing', async () => {
    const { calls, store: remote } = store();

    expect(await claimRemoteStore(remote, 'https://a.example', 'https://a.example')).toBe(false);

    expect(calls).toEqual([]);
  });

  test('a store that cannot be cleared is an error, not a server to load', async () => {
    const { store: remote } = store('clearStorageData');

    await expect(
      claimRemoteStore(remote, 'https://a.example', 'https://b.example'),
    ).rejects.toThrow();
  });
});
