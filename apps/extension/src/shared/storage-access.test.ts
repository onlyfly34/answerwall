import { describe, expect, test } from 'vitest';
import { restrictStorage } from './storage-access.ts';

describe('who may read the extension’s storage', () => {
  test('only the extension’s own pages and worker: content scripts are shut out', async () => {
    const levels: unknown[] = [];
    const done = await restrictStorage({
      setAccessLevel: async (options) => void levels.push(options),
    });
    expect(done).toBe(true);
    expect(levels).toEqual([{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  });

  test('a browser that refuses is reported, not thrown', async () => {
    const done = await restrictStorage({
      setAccessLevel: async () => {
        throw new Error('not supported');
      },
    });
    expect(done).toBe(false);
  });
});
