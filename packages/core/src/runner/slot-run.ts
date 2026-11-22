import { Buffer } from 'node:buffer';
import type { Clock, Logger, ProviderAdapter } from '../contracts/index.ts';
import type {
  ProviderErrorCode,
  ProviderInstance,
  StreamingMode,
  Usage,
} from '../protocol/index.ts';
import type { SlotEventBody } from './events.ts';
import { checkProviderEvent, utf8Prefix } from './provider-events.ts';
import { describeError } from './work-dirs.ts';
import type { WorkDirs } from './work-dirs.ts';

/** How a run ends on its own; cancel and timeout are decided by the manager. */
export type SlotOutcome =
  /** `elapsedMs` absent: the adapter gave no usable value and the manager measures. */
  | { type: 'done'; usage?: Usage; elapsedMs?: number }
  | { type: 'error'; code: ProviderErrorCode; message: string };

/** Where a run delivers its events. */
export interface SlotSink {
  /** The slot has its terminal event (from this run, a cancel or the timeout). */
  readonly finished: boolean;
  /** A non-terminal event. */
  emit(event: Exclude<SlotEventBody, { type: 'done' | 'error' | 'cancelled' | 'timeout' }>): void;
  /** The terminal event; ignored when the slot already has one. */
  finish(outcome: SlotOutcome): void;
}

export interface SlotExecution {
  adapter: ProviderAdapter;
  instance: ProviderInstance;
  prompt: string;
  model: string | undefined;
  effort: string | undefined;
  timeoutMs: number;
  /** Aborted by the manager as soon as the slot has its terminal event. */
  signal: AbortSignal;
  sink: SlotSink;
  workDirs: WorkDirs;
  workDirName: string;
  /** Answer plus reasoning text accepted before the slot is truncated, in UTF-8 bytes. */
  maxOutputBytes: number;
  maxNotices: number;
  /** How long an adapter gets to end its iteration once it is told to stop. */
  stopGraceMs: number;
  /** The provider's cached detection, for a `start` event that does not say. */
  detectedStreaming: () => StreamingMode;
  clock: Clock;
  logger: Logger;
}

/** Longest provider-supplied notice or error message passed on, in characters. */
const MAX_MESSAGE_CHARS = 2000;

const ABORTED = Symbol('aborted');

/** The iterator's next result, or `ABORTED` as soon as the signal fires, whichever is first. */
function nextOrAbort<T>(
  next: Promise<IteratorResult<T>>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      // The pending result is abandoned; its failure must not go unhandled.
      next.catch(() => {});
      resolve(ABORTED);
      return;
    }
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    next.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('provider iteration failed'));
      },
    );
  });
}

/** Turns what the adapter yields into slot events, tolerating everything the contract forbids. */
function createTranslator(run: SlotExecution): (value: unknown) => void {
  const { sink } = run;
  let started = false;
  let outputBytes = 0;
  let truncated = false;
  let notices = 0;
  let malformed = 0;

  const start = (streaming: StreamingMode | undefined): void => {
    started = true;
    sink.emit({
      type: 'start',
      at: run.clock.now(),
      streaming: streaming ?? run.detectedStreaming(),
    });
  };

  const text = (type: 'delta' | 'reasoning', value: string): void => {
    if (truncated || value === '') return;
    const room = run.maxOutputBytes - outputBytes;
    const size = Buffer.byteLength(value);
    if (size <= room) {
      outputBytes += size;
      sink.emit({ type, text: value });
      return;
    }
    // The provider keeps running so the slot still ends with its real result
    // and usage; everything it writes from here on is dropped.
    truncated = true;
    const head = utf8Prefix(value, room);
    if (head !== '') sink.emit({ type, text: head });
    sink.emit({
      type: 'notice',
      code: 'output_truncated',
      message: `The output exceeded ${run.maxOutputBytes} bytes and was truncated.`,
    });
  };

  return (value) => {
    const event = checkProviderEvent(value);
    if (!event) {
      if (++malformed === 1) run.logger.warn('ignoring malformed provider events');
      return;
    }
    if (event.type === 'start') {
      if (!started) start(event.streaming);
      return;
    }
    // An adapter that fails before it starts (not installed, not logged in)
    // takes the slot straight from queued to error.
    if (!started && event.type !== 'error') start(undefined);
    switch (event.type) {
      case 'delta':
      case 'reasoning':
        text(event.type, event.text);
        break;
      case 'notice':
        if (notices++ < run.maxNotices) {
          sink.emit({
            type: 'notice',
            code: 'provider',
            message: event.message.slice(0, MAX_MESSAGE_CHARS),
          });
        }
        break;
      case 'done':
        sink.finish({
          type: 'done',
          ...(event.usage ? { usage: event.usage } : {}),
          ...(event.elapsedMs === undefined ? {} : { elapsedMs: Math.round(event.elapsedMs) }),
        });
        break;
      case 'error':
        sink.finish({
          type: 'error',
          code: event.code,
          message: event.message.slice(0, MAX_MESSAGE_CHARS),
        });
        break;
    }
  };
}

/**
 * Tells the adapter to end its iteration and waits for that, but no longer
 * than the grace period: an adapter that ignores the abort must not hold the
 * slot's permit and work directory forever.
 */
async function stop(iterator: AsyncIterator<unknown>, run: SlotExecution): Promise<void> {
  const closed = (async () => {
    await iterator.return?.();
  })().catch((error: unknown) => {
    run.logger.debug('provider iteration failed while closing', { error: describeError(error) });
  });
  await new Promise<void>((resolve) => {
    const cancelGrace = run.clock.schedule(run.stopGraceMs, () => {
      run.logger.warn('provider did not stop in time', { graceMs: run.stopGraceMs });
      resolve();
    });
    void closed.then(() => {
      cancelGrace();
      resolve();
    });
  });
}

/**
 * Runs one admitted slot from work directory to cleanup. Resolves when the
 * provider is gone (or the grace period is over) and the directory removed;
 * never rejects. Whatever the adapter does, the slot ends with a terminal
 * event: the adapter's own, an error for a failed or resultless iteration, or
 * the one the manager emitted before aborting `signal`.
 */
export async function executeSlot(run: SlotExecution): Promise<void> {
  const { sink, signal } = run;
  let workDir: string;
  try {
    workDir = await run.workDirs.create(run.workDirName);
  } catch (error) {
    run.logger.error('could not create a work directory', { error: describeError(error) });
    sink.finish({
      type: 'error',
      code: 'spawn_failed',
      message: 'Could not create a working directory for the provider.',
    });
    return;
  }

  let iterator: AsyncIterator<unknown> | undefined;
  try {
    if (!sink.finished) {
      const translate = createTranslator(run);
      iterator = run.adapter
        .run(run.instance, {
          prompt: run.prompt,
          ...(run.model === undefined ? {} : { model: run.model }),
          ...(run.effort === undefined ? {} : { effort: run.effort }),
          timeoutMs: run.timeoutMs,
          signal,
          workDir,
        })
        [Symbol.asyncIterator]();
      while (!sink.finished) {
        const result = await nextOrAbort(iterator.next(), signal);
        // A cancel can land between the adapter delivering an event and this
        // code resuming; that event must not follow the slot's terminal one.
        if (result === ABORTED || result.done || sink.finished) break;
        translate(result.value);
      }
      sink.finish({
        type: 'error',
        code: 'bad_output',
        message: 'The provider ended without a result.',
      });
    }
  } catch (error) {
    run.logger.error('provider adapter failed', { error: describeError(error) });
    sink.finish({
      type: 'error',
      code: 'unknown',
      message: 'The provider adapter failed unexpectedly.',
    });
  } finally {
    if (iterator) await stop(iterator, run);
    await run.workDirs.remove(workDir);
  }
}
