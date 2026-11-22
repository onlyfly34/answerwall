import { createSignal } from 'solid-js';
import { describe, expect, test, vi } from 'vitest';
import { createDefaultSettings, initialAskSnapshot, LimitsSchema } from '@answerwall/core/protocol';
import type {
  AskSnapshot,
  Device,
  ProviderStatus,
  SettingsPatch,
  SettingsResponse,
} from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type { AskStream, StreamConnection } from '../contracts/services.ts';
import { readyProviderStatus } from '../contracts/testing.ts';
import { createAskStreamStore } from './ask-store.ts';
import { createDevicesStore } from './devices-store.ts';
import { createProvidersStore } from './providers-store.ts';
import { createSettingsStore } from './settings-store.ts';
import { testSettingsResponse } from './test-support.ts';

const request = { prompt: 'hi', targets: [{ slotId: 'a', providerId: 'claude' }] };

function askSnapshot(askId: string): AskSnapshot {
  return initialAskSnapshot({
    askId,
    conversationId: 'conv-1',
    prompt: 'hi',
    createdAt: 1,
    targets: [{ slotId: 'a', providerId: 'claude', kind: 'claude' }],
  });
}

interface OpenedStream extends AskStream {
  initial: AskSnapshot | undefined;
  closed: number;
  setConnection(connection: StreamConnection): void;
}

function askStoreHarness() {
  const opened: OpenedStream[] = [];
  const api = {
    ask: vi.fn(async () => ({ askId: `ask-${opened.length + 1}` })),
    getAsk: vi.fn(async (askId: string) => askSnapshot(askId)),
    cancelAsk: vi.fn(async () => ({ cancelled: [] })),
  };
  const store = createAskStreamStore({
    api,
    open(askId, initial) {
      const [connection, setConnection] = createSignal<StreamConnection>('connecting');
      const stream: OpenedStream = {
        askId,
        initial,
        closed: 0,
        snapshot: () => initial,
        connection,
        error: () => undefined,
        setConnection,
        close() {
          stream.closed += 1;
          setConnection('closed');
        },
      };
      opened.push(stream);
      return stream;
    },
  });
  return { api, store, opened };
}

describe('ask stream store', () => {
  test('submit posts the ask and follows it with the snapshot already in hand', async () => {
    const { api, store, opened } = askStoreHarness();
    expect(store.current()).toBeUndefined();

    const stream = await store.submit(request);

    expect(api.ask).toHaveBeenCalledWith(request);
    expect(api.getAsk).toHaveBeenCalledWith('ask-1');
    expect(stream).toBe(opened[0]);
    expect(store.current()).toBe(stream);
    expect(opened[0]?.initial?.askId).toBe('ask-1');
  });

  test('submit still follows the ask when its first snapshot cannot be read', async () => {
    const { api, store, opened } = askStoreHarness();
    api.getAsk.mockRejectedValueOnce(new ApiError('network', 0, 'unreachable'));

    const stream = await store.submit(request);

    expect(stream.askId).toBe('ask-1');
    expect(opened[0]?.initial).toBeUndefined();
    expect(store.current()).toBe(stream);
  });

  test('a refused submit rejects with the ApiError and keeps the ask on the wall', async () => {
    const { api, store, opened } = askStoreHarness();
    const first = await store.submit(request);
    const refusal = new ApiError('queue_full', 429, 'The queue is full');
    api.ask.mockRejectedValueOnce(refusal);

    await expect(store.submit(request)).rejects.toBe(refusal);

    expect(store.current()).toBe(first);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.closed).toBe(0);
  });

  test('following another ask closes the stream of the previous one, never the ask', async () => {
    const { api, store, opened } = askStoreHarness();
    await store.submit(request);

    const second = store.follow('ask-9');

    expect(opened[0]?.closed).toBe(1);
    expect(store.current()).toBe(second);
    expect(second.askId).toBe('ask-9');
    expect(api.cancelAsk).not.toHaveBeenCalled();
  });

  test('following the ask that is already followed keeps its stream', async () => {
    const { store, opened } = askStoreHarness();
    const first = store.follow('ask-9');

    expect(store.follow('ask-9')).toBe(first);
    expect(opened).toHaveLength(1);
    expect(first.connection()).toBe('connecting');
  });

  test.each(['closed', 'failed'] as const)(
    'following an ask whose stream is %s opens a new one',
    (state) => {
      const { store, opened } = askStoreHarness();
      store.follow('ask-9');
      opened[0]?.setConnection(state);

      const again = store.follow('ask-9');

      expect(again).toBe(opened[1]);
      expect(store.current()).toBe(again);
    },
  );

  test('cancel targets the current ask: one slot, or all of them', async () => {
    const { api, store } = askStoreHarness();
    await store.cancel('a');
    expect(api.cancelAsk).not.toHaveBeenCalled();

    await store.submit(request);
    await store.cancel('a');
    await store.cancel();

    expect(api.cancelAsk.mock.calls).toEqual([
      ['ask-1', 'a'],
      ['ask-1', undefined],
    ]);
    // Cancelling does not stop following: the cancelled events still arrive.
    expect(store.current()?.connection()).toBe('connecting');
  });

  test('a failed cancel rejects so the wall can report it', async () => {
    const { api, store } = askStoreHarness();
    await store.submit(request);
    const failure = new ApiError('not_found', 404, 'gone');
    api.cancelAsk.mockRejectedValueOnce(failure);

    await expect(store.cancel()).rejects.toBe(failure);
  });

  test('clear stops following and empties current', async () => {
    const { store, opened } = askStoreHarness();
    await store.submit(request);

    store.clear();
    store.clear();

    expect(store.current()).toBeUndefined();
    expect(opened[0]?.closed).toBe(1);
  });
});

describe('settings store', () => {
  function harness(initial: SettingsResponse = testSettingsResponse()) {
    let stored = initial;
    const api = {
      getSettings: vi.fn(async () => stored),
      updateSettings: vi.fn(async (patch: SettingsPatch) => {
        stored = {
          ...stored,
          settings: {
            ...stored.settings,
            ...(patch.language ? { language: patch.language } : {}),
            limits: LimitsSchema.parse({ ...stored.settings.limits, ...patch.limits }),
          },
        };
        return stored;
      }),
    };
    const onChange = vi.fn();
    return { api, onChange, store: createSettingsStore({ api, onChange }) };
  }

  test('nothing is known until load, which fills settings and the server facts together', async () => {
    const { store, onChange } = harness();
    expect(store.settings()).toBeUndefined();
    expect(store.server()).toBeUndefined();

    await store.load();

    expect(store.settings()).toEqual(createDefaultSettings());
    expect(store.server()?.tls.mode).toBe('off');
    expect(onChange).toHaveBeenCalledWith(createDefaultSettings(), undefined);
  });

  test("update sends the patch and takes the server's answer as the new state", async () => {
    const { api, store, onChange } = harness();
    await store.load();
    const patch: SettingsPatch = { language: 'zh-TW', limits: { maxAsksInFlight: 2 } };

    await store.update(patch);

    expect(api.updateSettings).toHaveBeenCalledWith(patch);
    expect(store.settings()?.language).toBe('zh-TW');
    expect(store.settings()?.limits.maxAsksInFlight).toBe(2);
    expect(onChange).toHaveBeenLastCalledWith(store.settings(), patch);
  });

  test('a refused update rejects and leaves the state as it was', async () => {
    const { api, store, onChange } = harness();
    await store.load();
    const refusal = new ApiError('bad_request', 400, 'limits.maxAsksInFlight: too big');
    api.updateSettings.mockRejectedValueOnce(refusal);

    await expect(store.update({ limits: { maxAsksInFlight: 99 } })).rejects.toBe(refusal);

    expect(store.settings()).toEqual(createDefaultSettings());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('a failed load rejects and leaves the store empty', async () => {
    const { api, store } = harness();
    api.getSettings.mockRejectedValueOnce(new ApiError('unauthorized', 401, 'no session'));

    await expect(store.load()).rejects.toMatchObject({ status: 401 });
    expect(store.settings()).toBeUndefined();
  });
});

describe('providers store', () => {
  const statuses = (): ProviderStatus[] =>
    createDefaultSettings().providers.map(readyProviderStatus);

  test('load reads the cached statuses; refresh asks for a new detection', async () => {
    const all = statuses();
    const api = {
      listProviders: vi.fn(async () => all),
      refreshProviders: vi.fn(async () => all.slice(0, 1)),
    };
    const store = createProvidersStore(api);
    expect(store.providers()).toEqual([]);
    expect(store.busy()).toBe(false);

    await store.load();
    expect(store.providers()).toEqual(all);
    expect(api.refreshProviders).not.toHaveBeenCalled();

    await store.refresh('claude');
    await store.refresh();
    expect(api.refreshProviders.mock.calls).toEqual([['claude'], [undefined]]);
    expect(store.providers()).toEqual(all.slice(0, 1));
  });

  test('busy covers the whole request, overlapping ones included', async () => {
    const pending: ((value: ProviderStatus[]) => void)[] = [];
    const wait = () => new Promise<ProviderStatus[]>((resolve) => pending.push(resolve));
    const store = createProvidersStore({ listProviders: wait, refreshProviders: wait });

    const load = store.load();
    const refresh = store.refresh();
    expect(store.busy()).toBe(true);

    pending[0]?.([]);
    await load;
    expect(store.busy()).toBe(true);

    pending[1]?.([]);
    await refresh;
    expect(store.busy()).toBe(false);
  });

  test('an older answer never overwrites a newer one', async () => {
    const all = statuses();
    const pending: ((value: ProviderStatus[]) => void)[] = [];
    const wait = () => new Promise<ProviderStatus[]>((resolve) => pending.push(resolve));
    const store = createProvidersStore({ listProviders: wait, refreshProviders: wait });

    const older = store.load();
    const newer = store.refresh();
    pending[1]?.(all.slice(0, 2));
    await newer;
    pending[0]?.(all);
    await older;

    expect(store.providers()).toEqual(all.slice(0, 2));
  });

  test('a failed refresh rejects, keeps the last statuses and is no longer busy', async () => {
    const all = statuses();
    const failure = new ApiError('internal', 500, 'oops');
    const store = createProvidersStore({
      listProviders: async () => all,
      refreshProviders: async () => {
        throw failure;
      },
    });
    await store.load();

    await expect(store.refresh()).rejects.toBe(failure);

    expect(store.providers()).toEqual(all);
    expect(store.busy()).toBe(false);
  });
});

describe('devices store', () => {
  const device = (id: string, current = false): Device => ({
    id,
    name: `Device ${id}`,
    createdAt: 1,
    lastUsedAt: null,
    current,
  });

  function harness() {
    const api = {
      listDevices: vi.fn(async () => ({
        devices: [device('a', true), device('b')],
        maxDevices: 8,
      })),
      revokeDevice: vi.fn(async () => undefined),
      createPairingCode: vi.fn(async () => ({ code: '12345678', expiresAt: 300_000 })),
    };
    return { api, store: createDevicesStore(api) };
  }

  test('load lists the devices and the limit', async () => {
    const { store } = harness();
    expect(store.devices()).toBeUndefined();

    await store.load();

    expect(store.devices()?.map((item) => item.id)).toEqual(['a', 'b']);
    expect(store.maxDevices()).toBe(8);
  });

  test('revoke removes the device from the list once the server agreed', async () => {
    const { api, store } = harness();
    await store.load();

    await store.revoke('b');

    expect(api.revokeDevice).toHaveBeenCalledWith('b');
    expect(store.devices()?.map((item) => item.id)).toEqual(['a']);
  });

  test('a refused revoke rejects and keeps the device listed', async () => {
    const { api, store } = harness();
    await store.load();
    api.revokeDevice.mockRejectedValueOnce(new ApiError('not_found', 404, 'gone'));

    await expect(store.revoke('b')).rejects.toMatchObject({ code: 'not_found' });
    expect(store.devices()).toHaveLength(2);
  });

  test('a new pairing code replaces the one shown before', async () => {
    const { api, store } = harness();
    expect(store.pairingCode()).toBeUndefined();

    await store.createPairingCode();
    api.createPairingCode.mockResolvedValueOnce({ code: '87654321', expiresAt: 600_000 });
    await store.createPairingCode();

    expect(store.pairingCode()).toEqual({ code: '87654321', expiresAt: 600_000 });
  });
});
