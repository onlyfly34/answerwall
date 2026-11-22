/**
 * What the wall does with its web cells (docs/web-cells.md): the frames
 * belong to the page that hosts them (`AppServices.webCells`), the slots to
 * the server. This module joins the two for the ask sent from this wall:
 * when the server starts a web slot, the cell's frame is asked to fill in
 * and read, and the one result goes back to the server.
 */
import { createContext, createSignal, useContext } from 'solid-js';
import { z } from 'zod';
import { BRAND, EntityIdSchema, SlotIdSchema } from '@answerwall/core/protocol';
import type { SlotSnapshot, WebCellsSettings, WebResultRequest } from '@answerwall/core/protocol';
import { ApiError } from '../../contracts/services.ts';
import type {
  ApiClient,
  Notifier,
  Translate,
  WebCellFailureDetail,
  WebCellFrame,
  WebCellRunResult,
  WebCellStage,
} from '../../contracts/services.ts';
import { readStored, writeStored } from './storage.ts';
import { utf8Bytes } from './slot-view.ts';

export const WEB_RUNS_KEY = `${BRAND.slug}.wall.web-runs.v1`;

const StartedSchema = z.object({ askId: EntityIdSchema, slotIds: z.array(SlotIdSchema) });

/** What a web cell says about itself besides its slot's state. */
export type WebCellNote =
  | { kind: 'stage'; stage: WebCellStage }
  /** The prompt was submitted in the page and nothing is read: no slot, nothing stored. */
  | { kind: 'sent' }
  /** Filling in failed for a cell that is not part of an ask. */
  | { kind: 'failed'; detail: WebCellFailureDetail };

export interface WebCellRunner {
  /** The frame of a cell, from the moment it exists until the returned function is called. */
  register(slotId: string, frame: WebCellFrame): () => void;
  /** Reactive. */
  note(slotId: string): WebCellNote | undefined;
  /**
   * The slots of the ask this wall sent, whenever they change. A web slot
   * that is `running` and not yet handled is run in its frame; one that
   * ended some other way (cancel, timeout, restart) stops being waited for.
   */
  follow(askId: string, prompt: string, slots: readonly SlotSnapshot[]): void;
  /** Reading answers is off: types and submits in these cells, which are part of no ask. */
  fillOnly(slotIds: readonly string[], prompt: string): void;
}

export interface WebCellRunnerDeps {
  api: Pick<ApiClient, 'submitWebResult'>;
  notify: Pick<Notifier, 'reportError'>;
  t: Translate;
  webCells(): WebCellsSettings | undefined;
  /** `limits.maxRequestBodyBytes`: a result larger than this is refused by the server. */
  maxRequestBodyBytes(): number;
  /** Pause before a result is sent again after a lost connection. */
  retryDelayMs?: number;
}

/** Room for the JSON around the text and for the request's own framing. */
const BODY_SLACK_BYTES = 512;
const SUBMIT_ATTEMPTS = 3;

/** Size of a string once it is a JSON string literal in a UTF-8 body. */
const jsonBytes = (text: string): number => utf8Bytes(JSON.stringify(text));

/**
 * The answer, cut so that the request that carries it stays below the
 * server's body limit. A cut answer ends with `marker`.
 */
export function fitAnswer(text: string, maxBodyBytes: number, marker: string): string {
  const budget = Math.max(0, maxBodyBytes - BODY_SLACK_BYTES);
  if (jsonBytes(text) <= budget) return text;
  const tail = `\n\n${marker}`;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, middle) + tail) <= budget) low = middle;
    else high = middle - 1;
  }
  // Never end on half of a surrogate pair.
  const code = text.charCodeAt(low - 1);
  if (code >= 0xd800 && code <= 0xdbff) low -= 1;
  return text.slice(0, low) + tail;
}

interface Run {
  controller: AbortController;
  /** The slot ended on the server; nothing is to be reported for it. */
  ended: boolean;
}

export function createWebCellRunner(deps: WebCellRunnerDeps): WebCellRunner {
  const { api, notify, t } = deps;
  const frames = new Map<string, WebCellFrame>();
  const runs = new Map<string, Run>();
  const [notes, replaceNotes] = createSignal<Record<string, WebCellNote | undefined>>({});
  // A note replaces the one before it as a whole.
  const setNotes = (slotId: string, note: WebCellNote | undefined): void => {
    replaceNotes((previous) => ({ ...previous, [slotId]: note }));
  };

  const keyOf = (askId: string, slotId: string): string => `${askId}/${slotId}`;

  /**
   * The slots this page already started to run, kept across a reload: a
   * reloaded page cannot know whether the prompt was submitted, so it must
   * not type it again.
   */
  function startedBefore(askId: string, slotId: string): boolean {
    const stored = readStored('session', WEB_RUNS_KEY, StartedSchema);
    return stored?.askId === askId && stored.slotIds.includes(slotId);
  }
  function remember(askId: string, slotId: string): void {
    const stored = readStored('session', WEB_RUNS_KEY, StartedSchema);
    const slotIds = stored?.askId === askId ? stored.slotIds : [];
    writeStored('session', WEB_RUNS_KEY, { askId, slotIds: [...slotIds, slotId] });
  }

  async function submit(askId: string, slotId: string, result: WebResultRequest): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await api.submitWebResult(askId, slotId, result);
        return;
      } catch (error) {
        if (error instanceof ApiError) {
          // The slot ended some other way, or the ask is gone: nothing left to say.
          if (error.code === 'conflict' || error.code === 'not_found') return;
          if (error.code === 'network' && attempt < SUBMIT_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 1_000));
            continue;
          }
        }
        notify.reportError(error);
        return;
      }
    }
  }

  function resultFor(result: WebCellRunResult): WebResultRequest | undefined {
    switch (result.outcome) {
      case 'done':
        return {
          outcome: 'done',
          text: fitAnswer(result.text, deps.maxRequestBodyBytes(), t('wall.web.cut')),
        };
      case 'failed':
        return {
          outcome: 'failed',
          code: result.code,
          message: t(`wall.web.failure.${result.detail}`),
        };
      case 'submitted':
        // Asked to read, the frame never answers this.
        return { outcome: 'failed', code: 'unknown' };
      case 'aborted':
        return undefined;
    }
  }

  async function begin(askId: string, slotId: string, prompt: string): Promise<void> {
    const run: Run = { controller: new AbortController(), ended: false };
    runs.set(keyOf(askId, slotId), run);
    if (startedBefore(askId, slotId)) {
      await submit(askId, slotId, { outcome: 'cancelled', reason: t('wall.web.reason.reloaded') });
      return;
    }
    remember(askId, slotId);
    const frame = frames.get(slotId);
    if (!frame) {
      await submit(askId, slotId, {
        outcome: 'failed',
        code: 'unsupported',
        message: t('wall.web.failure.no_connection'),
      });
      return;
    }
    const result = await frame.run({
      prompt,
      fill: deps.webCells()?.fillPrompt === true,
      read: true,
      signal: run.controller.signal,
      onStage: (stage) => setNotes(slotId, { kind: 'stage', stage }),
    });
    setNotes(slotId, undefined);
    if (run.ended) return;
    await submit(
      askId,
      slotId,
      // Aborted without the slot having ended: the frame went away.
      resultFor(result) ?? { outcome: 'cancelled', reason: t('wall.web.reason.closed') },
    );
  }

  async function fill(slotId: string, prompt: string): Promise<void> {
    const frame = frames.get(slotId);
    if (!frame) {
      setNotes(slotId, { kind: 'failed', detail: 'no_connection' });
      return;
    }
    const result = await frame.run({
      prompt,
      fill: true,
      read: false,
      signal: new AbortController().signal,
      onStage: (stage) => setNotes(slotId, { kind: 'stage', stage }),
    });
    if (result.outcome === 'failed') setNotes(slotId, { kind: 'failed', detail: result.detail });
    else setNotes(slotId, result.outcome === 'aborted' ? undefined : { kind: 'sent' });
  }

  return {
    register(slotId, frame) {
      frames.set(slotId, frame);
      return () => {
        if (frames.get(slotId) === frame) frames.delete(slotId);
        setNotes(slotId, undefined);
      };
    },
    note: (slotId) => notes()[slotId],
    follow(askId, prompt, slots) {
      for (const slot of slots) {
        if (slot.kind !== 'web') continue;
        const run = runs.get(keyOf(askId, slot.slotId));
        if (slot.status === 'queued') {
          setNotes(slot.slotId, undefined);
        } else if (slot.status === 'running') {
          if (!run) void begin(askId, slot.slotId, prompt);
        } else if (run && !run.ended) {
          run.ended = true;
          run.controller.abort();
        }
      }
    },
    fillOnly(slotIds, prompt) {
      for (const slotId of slotIds) void fill(slotId, prompt);
    },
  };
}

export const WebCellRunnerContext = createContext<WebCellRunner>();

/** The runner of the wall this component is part of; none on a page without web cells. */
export function useWebCellRunner(): WebCellRunner | undefined {
  return useContext(WebCellRunnerContext);
}
