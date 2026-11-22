/**
 * The wall's arrangement on this device: which cells, in which order, with
 * which layout, plus the draft prompt and the ask being followed. It lives in
 * the session storage, so it survives a reload but a new session starts from
 * the default preset. The default preset's id is remembered per device.
 */
import { createEffect, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { z } from 'zod';
import {
  AskTargetSchema,
  BRAND,
  EntityIdSchema,
  LayoutSettingsSchema,
  SlotIdSchema,
} from '@answerwall/core/protocol';
import type { AskTarget, LayoutSettings, Preset } from '@answerwall/core/protocol';
import { copyTarget, makeTarget, moveItem, newSlotId } from './slots.ts';
import { readStored, writeStored } from './storage.ts';

export const ARRANGEMENT_KEY = `${BRAND.slug}.wall.v1`;
export const DEFAULT_PRESET_KEY = `${BRAND.slug}.wall.default-preset.v1`;

const ArrangementSchema = z.object({
  slots: z.array(AskTargetSchema),
  /** `null`: follow the shared layout settings. */
  layout: LayoutSettingsSchema.nullable(),
  maximised: SlotIdSchema.nullable(),
  presetId: EntityIdSchema.nullable(),
  prompt: z.string(),
  askId: EntityIdSchema.nullable(),
});
type Arrangement = z.infer<typeof ArrangementSchema>;

export interface WallState {
  /** A store: reading a slot's field tracks just that field. */
  readonly slots: readonly AskTarget[];
  layout: Accessor<LayoutSettings | null>;
  maximised: Accessor<string | null>;
  /** The preset the arrangement was taken from, if any. */
  presetId: Accessor<string | null>;
  prompt: Accessor<string>;
  /** The ask submitted from this wall, followed again after a reload. */
  askId: Accessor<string | null>;
  defaultPresetId: Accessor<string | null>;
  /** Nothing was restored and the user has not arranged anything yet. */
  pristine: Accessor<boolean>;

  addSlot(providerId: string, model?: string, effort?: string, afterSlotId?: string): string;
  removeSlot(slotId: string): void;
  updateSlot(
    slotId: string,
    change: { providerId?: string; model?: string | null; effort?: string | null },
  ): void;
  moveSlot(slotId: string, toIndex: number): void;
  /** Replaces the whole slot set, for example with a past ask's. */
  setSlots(slots: readonly AskTarget[]): void;
  applyPreset(preset: Preset): void;
  setLayout(layout: LayoutSettings | null): void;
  setMaximised(slotId: string | null): void;
  setPresetId(presetId: string | null): void;
  setPrompt(prompt: string): void;
  setAskId(askId: string | null): void;
  setDefaultPresetId(presetId: string | null): void;
}

/**
 * Call inside a component: the state persists itself with an effect.
 * `initialSlots` is used when the session has no arrangement yet.
 */
export function createWallState(initialSlots: () => AskTarget[]): WallState {
  const stored = readStored('session', ARRANGEMENT_KEY, ArrangementSchema);
  const [state, setState] = createStore<Arrangement>(
    stored ?? {
      slots: initialSlots(),
      layout: null,
      maximised: null,
      presetId: null,
      prompt: '',
      askId: null,
    },
  );
  const [pristine, setPristine] = createSignal(stored === undefined);
  const [defaultPresetId, setDefaultPreset] = createSignal(
    readStored('local', DEFAULT_PRESET_KEY, EntityIdSchema) ?? null,
  );

  createEffect(() => {
    writeStored('session', ARRANGEMENT_KEY, {
      slots: state.slots.map(copyTarget),
      layout: state.layout && { ...state.layout },
      maximised: state.maximised,
      presetId: state.presetId,
      prompt: state.prompt,
      askId: state.askId,
    } satisfies Arrangement);
  });

  function arrange(slots: readonly AskTarget[]): void {
    setPristine(false);
    setState('slots', reconcile(slots.map(copyTarget), { key: 'slotId' }));
    if (state.maximised !== null && !slots.some((slot) => slot.slotId === state.maximised)) {
      setState('maximised', null);
    }
  }

  const current = (): AskTarget[] => unwrap(state.slots);

  return {
    get slots() {
      return state.slots;
    },
    layout: () => state.layout,
    maximised: () => state.maximised,
    presetId: () => state.presetId,
    prompt: () => state.prompt,
    askId: () => state.askId,
    defaultPresetId,
    pristine,

    addSlot(providerId, model, effort, afterSlotId) {
      const slots = current();
      const slotId = newSlotId(slots.map((slot) => slot.slotId));
      const after = slots.findIndex((slot) => slot.slotId === afterSlotId);
      const index = after === -1 ? slots.length : after + 1;
      arrange([
        ...slots.slice(0, index),
        makeTarget(slotId, providerId, model, effort),
        ...slots.slice(index),
      ]);
      return slotId;
    },
    removeSlot(slotId) {
      arrange(current().filter((slot) => slot.slotId !== slotId));
    },
    updateSlot(slotId, change) {
      arrange(
        current().map((slot) => {
          if (slot.slotId !== slotId) return slot;
          const pick = (next: string | null | undefined, previous: string | undefined) =>
            next === undefined ? previous : (next ?? undefined);
          return makeTarget(
            slotId,
            change.providerId ?? slot.providerId,
            pick(change.model, slot.model),
            pick(change.effort, slot.effort),
          );
        }),
      );
    },
    moveSlot(slotId, toIndex) {
      const slots = current();
      arrange(
        moveItem(
          slots,
          slots.findIndex((slot) => slot.slotId === slotId),
          toIndex,
        ),
      );
    },
    setSlots(slots) {
      arrange(slots);
    },
    applyPreset(preset) {
      arrange(preset.slots);
      setState({ layout: preset.layout ?? null, presetId: preset.id, maximised: null });
    },
    setLayout(layout) {
      setState('layout', layout);
    },
    setMaximised(slotId) {
      setState('maximised', slotId);
    },
    setPresetId(presetId) {
      setState('presetId', presetId);
    },
    setPrompt(prompt) {
      setState('prompt', prompt);
    },
    setAskId(askId) {
      setState('askId', askId);
    },
    setDefaultPresetId(presetId) {
      setDefaultPreset(presetId);
      writeStored('local', DEFAULT_PRESET_KEY, presetId ?? undefined);
    },
  };
}
