import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('whenever the worker starts, the storage is closed to content scripts', async () => {
  const levels: unknown[] = [];
  const event = { addListener: () => undefined, removeListener: () => undefined };
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `chrome-extension://id/${path}`,
      onStartup: event,
      onInstalled: event,
    },
    action: { onClicked: event },
    tabs: { onRemoved: event, onUpdated: event },
    storage: {
      local: { setAccessLevel: async (options: unknown) => void levels.push(options) },
    },
  });
  await import('./main.ts');
  expect(levels).toEqual([{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});
