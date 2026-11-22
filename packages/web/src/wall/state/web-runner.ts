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

/**
 * The part of the Web Locks API the runner uses (`navigator.locks`). A lock
 * is held by one document and released when its callback has finished or the
 * document is gone, which is what tells a reloaded page from a second page
 * that is open at the same time.
 */
export interface RunLocks {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

function browserLocks(): RunLocks | undefined {
  try {
    return globalThis.navigator.locks;
  } catch {
    return undefined;
  }
}

export interface WebCellRunnerDeps {
  api: Pick<ApiClient, 'submitWebResult'>;
  notify: Pick<Notifier, 'reportError'>;
  t: Translate;
  webCells(): WebCellsSettings | undefined;
  /** `limits.maxRequestBodyBytes`: a result larger than this is refused by the server. */
  maxRequestBodyBytes(): number;
  /** Pause before a result is sent again after a lost connection; it grows with every attempt. */
  retryDelayMs?: number;
  /** The browser's locks by default; `null` for none. */
  locks?: RunLocks | null;
}

/** Room for the JSON around the text and for the request's own framing. */
const BODY_SLACK_BYTES = 512;
/** After this many attempts in a row without a connection the user is told, once. */
const SUBMIT_ATTEMPTS = 3;
/** The pause between attempts doubles up to this many times the first one. */
const MAX_RETRY_FACTOR = 32;

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
  const locks = deps.locks === undefined ? browserLocks() : deps.locks;

  /**
   * Runs `work` while this document holds the lock of the slot. The page
   * that started a slot holds it until the result is with the server. A
   * page that finds the lock taken is a second page of the same wall (a
   * duplicated tab carries the session storage with it): it waits, and gets
   * its turn only when the first page is gone or has finished. Waiting ends
   * when the slot ends.
   */
  async function holding(name: string, run: Run, work: () => Promise<void>): Promise<void> {
    if (!locks) return work();
    let entered = false;
    try {
      await locks.request(name, { signal: run.controller.signal }, () => {
        entered = true;
        return work();
      });
    } catch (error) {
      if (entered) throw error;
      // The slot ended while this page waited; or there are no locks here after all.
      if (!run.controller.signal.aborted) await work();
    }
  }

  /**
   * The slots this page already started to run, kept across a reload: a
   * reloaded page cannot know whether the prompt was submitted, so it must
   * not type it again. A duplicated tab inherits the list; the lock of the
   * slot (see `holding`) says whether the page that started it is still there.
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

  /**
   * Sends the slot's one result. Without a connection the result is kept and
   * sent again, at growing intervals, for as long as the slot has not ended:
   * the server takes the same result twice. A finished answer the server
   * refuses for any other reason is followed by a failure, which it does
   * take, so that the slot ends now and not at its timeout.
   */
  async function submit(
    run: Run,
    askId: string,
    slotId: string,
    result: WebResultRequest,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await api.submitWebResult(askId, slotId, result);
        return;
      } catch (error) {
        if (error instanceof ApiError) {
          // The slot ended some other way, or the ask is gone: nothing left to say.
          if (error.code === 'conflict' || error.code === 'not_found') return;
          if (error.code === 'network') {
            if (run.ended) return;
            if (attempt === SUBMIT_ATTEMPTS) notify.reportError(error);
            const factor = Math.min(2 ** (attempt - 1), MAX_RETRY_FACTOR);
            await new Promise((resolve) =>
              setTimeout(resolve, (deps.retryDelayMs ?? 1_000) * factor),
            );
            if (run.ended) return;
            continue;
          }
        }
        notify.reportError(error);
        if (result.outcome === 'done') {
          await submit(run, askId, slotId, {
            outcome: 'failed',
            code: 'unknown',
            message: t('wall.web.failure.refused'),
          });
        }
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
    const resumed = startedBefore(askId, slotId);
    if (!resumed) remember(askId, slotId);
    await holding(`${BRAND.slug}.web-run.${keyOf(askId, slotId)}`, run, async () => {
      if (run.ended) return;
      if (resumed) {
        // The page that started this slot is gone: this one was reloaded, or
        // is what is left of a duplicated tab.
        await submit(run, askId, slotId, {
          outcome: 'cancelled',
          reason: t('wall.web.reason.reloaded'),
        });
        return;
      }
      await work(run, askId, slotId, prompt);
    });
  }

  async function work(run: Run, askId: string, slotId: string, prompt: string): Promise<void> {
    const frame = frames.get(slotId);
    if (!frame) {
      await submit(run, askId, slotId, {
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
      run,
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
