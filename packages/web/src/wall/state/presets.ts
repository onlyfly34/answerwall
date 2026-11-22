/** The preset list and its operations; presets are shared through the API. */
import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { LayoutSettings, Preset, PresetInput } from '@answerwall/core/protocol';
import type { AppServices } from '../../contracts/services.ts';
import { copyTarget, newId, sameTargets } from './slots.ts';
import type { WallState } from './wall-state.ts';

export interface Presets {
  list: Accessor<Preset[]>;
  /** The preset the wall was taken from, while it still exists. */
  active: Accessor<Preset | undefined>;
  /** The wall no longer matches the active preset. */
  modified: Accessor<boolean>;
  /** Loads the list; applies the default preset to a wall nobody has arranged yet. */
  load(): Promise<void>;
  apply(preset: Preset): void;
  /** Saves the wall as a new preset and makes it the active one. */
  saveAs(name: string): Promise<boolean>;
  /** Overwrites the active preset with the wall. */
  updateActive(): Promise<boolean>;
  rename(preset: Preset, name: string): Promise<boolean>;
  remove(preset: Preset): Promise<boolean>;
  setDefault(preset: Preset | undefined): void;
}

const sameLayout = (a: LayoutSettings | null, b: LayoutSettings | undefined): boolean =>
  a === null || b === undefined
    ? a === null && b === undefined
    : a.mode === b.mode && a.columns === b.columns && a.minCellWidth === b.minCellWidth;

export function createPresets(
  services: Pick<AppServices, 'api' | 'notify'>,
  state: WallState,
): Presets {
  const { api, notify } = services;
  const [list, setList] = createSignal<Preset[]>([]);

  const active = (): Preset | undefined => list().find((preset) => preset.id === state.presetId());

  function wallAsInput(name: string): PresetInput {
    const layout = state.layout();
    return {
      name,
      slots: state.slots.map(copyTarget),
      ...(layout ? { layout: { ...layout } } : {}),
    };
  }

  /** Runs one API operation; a failure is reported and yields `false`. */
  async function attempt(operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      notify.reportError(error);
      return false;
    }
  }

  function put(saved: Preset): void {
    setList((previous) =>
      previous.some((preset) => preset.id === saved.id)
        ? previous.map((preset) => (preset.id === saved.id ? saved : preset))
        : [...previous, saved],
    );
  }

  return {
    list,
    active,
    modified: () => {
      const preset = active();
      return (
        preset !== undefined &&
        !(sameTargets(state.slots, preset.slots) && sameLayout(state.layout(), preset.layout))
      );
    },
    load: async () => {
      await attempt(async () => {
        const presets = await api.listPresets();
        setList(presets);
        const preferred = presets.find((preset) => preset.id === state.defaultPresetId());
        if (preferred && state.pristine()) state.applyPreset(preferred);
      });
    },
    apply: (preset) => state.applyPreset(preset),
    saveAs: (name) => {
      const id = newId(
        'p',
        list().map((preset) => preset.id),
      );
      const input = wallAsInput(name.trim());
      return attempt(async () => {
        put(await api.savePreset(id, input));
        state.setPresetId(id);
      });
    },
    updateActive: () => {
      const preset = active();
      if (!preset) return Promise.resolve(false);
      const input = wallAsInput(preset.name);
      return attempt(async () => put(await api.savePreset(preset.id, input)));
    },
    rename: (preset, name) =>
      attempt(async () => {
        const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = preset;
        put(await api.savePreset(id, { ...input, name: name.trim() }));
      }),
    remove: (preset) =>
      attempt(async () => {
        await api.deletePreset(preset.id);
        setList((previous) => previous.filter((candidate) => candidate.id !== preset.id));
        if (state.presetId() === preset.id) state.setPresetId(null);
        if (state.defaultPresetId() === preset.id) state.setDefaultPresetId(null);
      }),
    setDefault: (preset) => state.setDefaultPresetId(preset?.id ?? null),
  };
}
