import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AskTarget, Preset } from '@answerwall/core/protocol';
import { ApiError } from '../../contracts/services.ts';
import { createFakeServices } from '../../contracts/testing.ts';
import { createPresets } from './presets.ts';
import type { Presets } from './presets.ts';
import { ARRANGEMENT_KEY, createWallState, DEFAULT_PRESET_KEY } from './wall-state.ts';
import type { WallState } from './wall-state.ts';

const initial = (): AskTarget[] => [
  { slotId: 's-1', providerId: 'claude' },
  { slotId: 's-2', providerId: 'codex' },
];

let disposers: (() => void)[] = [];

function wallState(): WallState {
  return createRoot((dispose) => {
    disposers.push(dispose);
    return createWallState(initial);
  });
}

const stored = (): unknown => JSON.parse(sessionStorage.getItem(ARRANGEMENT_KEY) ?? 'null');
const providersOf = (state: WallState): string[] => state.slots.map((slot) => slot.providerId);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
});

describe('the wall arrangement', () => {
  test('a new session starts from the initial slots and is pristine', () => {
    const state = wallState();
    expect(state.slots).toEqual(initial());
    expect(state.pristine()).toBe(true);
    expect(state.layout()).toBeNull();
    expect(state.maximised()).toBeNull();
    expect(state.prompt()).toBe('');
    expect(state.askId()).toBeNull();
  });

  test('cells are added at the end or after a given cell, any provider any number of times', () => {
    const state = wallState();
    const added = state.addSlot('claude', 'opus', 'high');
    const duplicate = state.addSlot('claude', 'haiku', undefined, 's-1');
    expect(state.slots.map((slot) => slot.slotId)).toEqual(['s-1', duplicate, 's-2', added]);
    expect(state.slots[1]).toEqual({ slotId: duplicate, providerId: 'claude', model: 'haiku' });
    expect(state.slots[3]).toEqual({
      slotId: added,
      providerId: 'claude',
      model: 'opus',
      effort: 'high',
    });
    expect(new Set(state.slots.map((slot) => slot.slotId)).size).toBe(4);
    expect(state.pristine()).toBe(false);
  });

  test('a slot changes field by field; null returns a field to the default', () => {
    const state = wallState();
    state.updateSlot('s-1', { model: 'opus', effort: 'high' });
    expect(state.slots[0]).toEqual({
      slotId: 's-1',
      providerId: 'claude',
      model: 'opus',
      effort: 'high',
    });
    state.updateSlot('s-1', { effort: null });
    expect(state.slots[0]).toEqual({ slotId: 's-1', providerId: 'claude', model: 'opus' });
    state.updateSlot('s-1', { providerId: 'grok', model: null, effort: null });
    expect(state.slots[0]).toEqual({ slotId: 's-1', providerId: 'grok' });
    state.updateSlot('unknown', { model: 'x' });
    expect(providersOf(state)).toEqual(['grok', 'codex']);
  });

  test('cells move and are removed; removing the maximised cell restores the grid', () => {
    const state = wallState();
    state.addSlot('grok');
    state.moveSlot('s-1', 2);
    expect(providersOf(state)).toEqual(['codex', 'grok', 'claude']);
    state.moveSlot('missing', 0);
    expect(providersOf(state)).toEqual(['codex', 'grok', 'claude']);
    state.setMaximised('s-2');
    state.removeSlot('s-1');
    expect(state.maximised()).toBe('s-2');
    state.removeSlot('s-2');
    expect(state.maximised()).toBeNull();
    expect(providersOf(state)).toEqual(['grok']);
  });

  test('the arrangement survives a reload through the session storage', () => {
    const first = wallState();
    first.addSlot('grok', 'grok-4');
    first.setLayout({ mode: 'fixed', minCellWidth: 400, columns: 4 });
    first.setPrompt('draft');
    first.setAskId('ask-7');
    first.setMaximised('s-2');
    first.setPresetId('p-1');
    expect(stored()).toMatchObject({ prompt: 'draft', askId: 'ask-7', maximised: 's-2' });

    const second = wallState();
    expect(second.pristine()).toBe(false);
    expect(providersOf(second)).toEqual(['claude', 'codex', 'grok']);
    expect(second.slots[2]?.model).toBe('grok-4');
    expect(second.layout()).toEqual({ mode: 'fixed', minCellWidth: 400, columns: 4 });
    expect(second.prompt()).toBe('draft');
    expect(second.askId()).toBe('ask-7');
    expect(second.maximised()).toBe('s-2');
    expect(second.presetId()).toBe('p-1');
  });

  test('a stored arrangement that is corrupt or of another shape is ignored', () => {
    sessionStorage.setItem(ARRANGEMENT_KEY, '{not json');
    expect(wallState().slots).toEqual(initial());
    sessionStorage.setItem(ARRANGEMENT_KEY, JSON.stringify({ slots: [{ slotId: 'bad id!' }] }));
    const state = wallState();
    expect(state.slots).toEqual(initial());
    expect(state.pristine()).toBe(true);
  });

  test('the wall works without any storage', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      const state = wallState();
      state.addSlot('grok');
      state.setPrompt('still works');
      expect(providersOf(state)).toEqual(['claude', 'codex', 'grok']);
      expect(state.prompt()).toBe('still works');
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  test('the default preset is remembered per device', () => {
    const state = wallState();
    state.setDefaultPresetId('p-9');
    expect(wallState().defaultPresetId()).toBe('p-9');
    state.setDefaultPresetId(null);
    expect(localStorage.getItem(DEFAULT_PRESET_KEY)).toBeNull();
    expect(wallState().defaultPresetId()).toBeNull();
  });

  test('a preset replaces slots and layout and restores the grid', () => {
    const state = wallState();
    state.setMaximised('s-1');
    state.applyPreset(preset('p-1', 'Duo'));
    expect(state.presetId()).toBe('p-1');
    expect(state.slots).toEqual(preset('p-1', 'Duo').slots);
    expect(state.layout()).toEqual({ mode: 'fixed', minCellWidth: 360, columns: 2 });
    expect(state.maximised()).toBeNull();
    const { layout: _layout, ...withoutLayout } = preset('p-2', 'Plain');
    state.applyPreset(withoutLayout);
    expect(state.layout()).toBeNull();
  });
});

function preset(id: string, name: string): Preset {
  return {
    id,
    name,
    slots: [
      { slotId: 'a', providerId: 'grok' },
      { slotId: 'b', providerId: 'grok', model: 'grok-4' },
    ],
    layout: { mode: 'fixed', minCellWidth: 360, columns: 2 },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('presets', () => {
  function setup(server: Preset[], failing = false) {
    const services = createFakeServices({
      api: {
        listPresets: async () => server.map((item) => structuredClone(item)),
        savePreset: async (presetId, input) => {
          if (failing) throw new ApiError('conflict', 409, 'Too many presets');
          const saved: Preset = {
            ...structuredClone(input),
            id: presetId,
            createdAt: 5,
            updatedAt: 6,
          };
          const index = server.findIndex((item) => item.id === presetId);
          if (index === -1) server.push(saved);
          else server[index] = saved;
          return saved;
        },
        deletePreset: async (presetId) => {
          if (failing) throw new ApiError('not_found', 404, 'No such preset');
          server.splice(
            server.findIndex((item) => item.id === presetId),
            1,
          );
        },
      },
    });
    const state = wallState();
    const presets: Presets = createPresets(services, state);
    return { services, state, presets };
  }

  test('loading applies the default preset to a pristine wall only', async () => {
    localStorage.setItem(DEFAULT_PRESET_KEY, JSON.stringify('p-1'));
    const fresh = setup([preset('p-1', 'Duo')]);
    await fresh.presets.load();
    expect(fresh.presets.list()).toHaveLength(1);
    expect(fresh.state.presetId()).toBe('p-1');
    expect(providersOf(fresh.state)).toEqual(['grok', 'grok']);

    // The session now has an arrangement, so a reload keeps what the user made of it.
    fresh.state.removeSlot('a');
    const reloaded = setup([preset('p-1', 'Duo')]);
    await reloaded.presets.load();
    expect(providersOf(reloaded.state)).toEqual(['grok']);
  });

  test('a default preset that no longer exists is not applied', async () => {
    localStorage.setItem(DEFAULT_PRESET_KEY, JSON.stringify('p-gone'));
    const { presets, state } = setup([preset('p-1', 'Duo')]);
    await presets.load();
    expect(state.presetId()).toBeNull();
    expect(providersOf(state)).toEqual(['claude', 'codex']);
  });

  test('saving stores the slots and the chosen layout under a new id and activates it', async () => {
    const server: Preset[] = [];
    const { presets, state, services } = setup(server);
    state.setLayout({ mode: 'fixed', minCellWidth: 360, columns: 2 });
    expect(await presets.saveAs('  Pair  ')).toBe(true);
    const call = services.apiCalls.find((entry) => entry.method === 'savePreset');
    expect(call?.args[0]).toMatch(/^p-[a-z0-9]{10}$/);
    expect(call?.args[1]).toEqual({
      name: 'Pair',
      slots: initial(),
      layout: { mode: 'fixed', minCellWidth: 360, columns: 2 },
    });
    expect(presets.active()?.name).toBe('Pair');
    expect(presets.modified()).toBe(false);
    expect(server).toHaveLength(1);
  });

  test('a wall that follows the shared layout saves no layout', async () => {
    const { presets, services } = setup([]);
    await presets.saveAs('Plain');
    const call = services.apiCalls.find((entry) => entry.method === 'savePreset');
    expect(call?.args[1]).toEqual({ name: 'Plain', slots: initial() });
  });

  test('the active preset is modified by any change and can be updated in place', async () => {
    const server = [preset('p-1', 'Duo')];
    const { presets, state } = setup(server);
    await presets.load();
    presets.apply(server[0] as Preset);
    expect(presets.modified()).toBe(false);
    state.updateSlot('a', { model: 'grok-3' });
    expect(presets.modified()).toBe(true);
    expect(await presets.updateActive()).toBe(true);
    expect(presets.modified()).toBe(false);
    expect(server[0]?.slots[0]).toEqual({ slotId: 'a', providerId: 'grok', model: 'grok-3' });
    expect(server[0]?.name).toBe('Duo');

    state.setLayout(null);
    expect(presets.modified()).toBe(true);
  });

  test('updating without an active preset does nothing', async () => {
    const { presets, services } = setup([]);
    expect(await presets.updateActive()).toBe(false);
    expect(services.apiCalls).toEqual([]);
  });

  test('renaming keeps the slots and layout of the preset, not of the wall', async () => {
    const server = [preset('p-1', 'Duo')];
    const { presets, services } = setup(server);
    await presets.load();
    expect(await presets.rename(presets.list()[0] as Preset, ' Twins ')).toBe(true);
    const call = services.apiCalls.find((entry) => entry.method === 'savePreset');
    expect(call?.args).toEqual([
      'p-1',
      {
        name: 'Twins',
        slots: preset('p-1', 'Duo').slots,
        layout: preset('p-1', 'Duo').layout,
      },
    ]);
    expect(presets.list()[0]?.name).toBe('Twins');
  });

  test('deleting forgets the preset as active and as default but keeps the cells', async () => {
    const server = [preset('p-1', 'Duo'), preset('p-2', 'Other')];
    const { presets, state } = setup(server);
    await presets.load();
    presets.apply(server[0] as Preset);
    presets.setDefault(server[0]);
    expect(await presets.remove(presets.list()[0] as Preset)).toBe(true);
    expect(presets.list().map((item) => item.id)).toEqual(['p-2']);
    expect(state.presetId()).toBeNull();
    expect(state.defaultPresetId()).toBeNull();
    expect(providersOf(state)).toEqual(['grok', 'grok']);
  });

  test('a failed operation is reported and changes nothing', async () => {
    const server = [preset('p-1', 'Duo')];
    const { presets, state, services } = setup(server, true);
    await presets.load();
    expect(await presets.saveAs('New')).toBe(false);
    expect(await presets.remove(presets.list()[0] as Preset)).toBe(false);
    expect(presets.list()).toHaveLength(1);
    expect(state.presetId()).toBeNull();
    expect(services.errors).toHaveLength(2);
  });

  test('a failed load is reported and leaves the wall as it is', async () => {
    const services = createFakeServices();
    const state = wallState();
    const presets = createPresets(services, state);
    await presets.load();
    expect(services.errors).toHaveLength(1);
    expect(presets.list()).toEqual([]);
    expect(providersOf(state)).toEqual(['claude', 'codex']);
  });
});
