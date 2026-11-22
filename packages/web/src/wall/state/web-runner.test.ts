import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_WEB_CELLS } from '@answerwall/core/protocol';
import type { WebCellsSettings, WebResultRequest } from '@answerwall/core/protocol';
import { createI18n } from '../../contracts/i18n.ts';
import { ApiError } from '../../contracts/services.ts';
import type {
  WebCellFrame,
  WebCellRunOptions,
  WebCellRunResult,
} from '../../contracts/services.ts';
import { slotSnapshot } from '../test-support.tsx';
import { utf8Bytes } from './slot-view.ts';
import { createWebCellRunner, fitAnswer, WEB_RUNS_KEY } from './web-runner.ts';

const t = createI18n('en').t;
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

/** A frame whose runs the test finishes by hand. */
function fakeFrame() {
  const runs: { options: WebCellRunOptions; finish(result: WebCellRunResult): void }[] = [];
  const frame: WebCellFrame = {
    connection: () => 'ready',
    run: (options) =>
      new Promise((resolve) => {
        const finish = (result: WebCellRunResult): void => resolve(result);
        runs.push({ options, finish });
        options.signal.addEventListener('abort', () => finish({ outcome: 'aborted' }));
      }),
    dispose: () => {
      for (const run of runs) run.finish({ outcome: 'aborted' });
    },
  };
  return { frame, runs };
}

function harness(
  switches: Partial<WebCellsSettings> = { enabled: true, fillPrompt: true, readAnswer: true },
  answer: (result: WebResultRequest) => Promise<void> = async () => undefined,
) {
  const submitted: { askId: string; slotId: string; result: WebResultRequest }[] = [];
  const errors: unknown[] = [];
  const runner = createRoot(() =>
    createWebCellRunner({
      api: {
        async submitWebResult(askId, slotId, result) {
          submitted.push({ askId, slotId, result });
          await answer(result);
          return { status: 'done', truncated: false };
        },
      },
      notify: { reportError: (error) => void errors.push(error) },
      t,
      webCells: () => ({ ...DEFAULT_WEB_CELLS, ...switches }),
      maxRequestBodyBytes: () => 4_096,
      retryDelayMs: 0,
    }),
  );
  return { runner, submitted, errors };
}

const web = (status: 'queued' | 'running' | 'done' | 'cancelled' | 'timeout' | 'error') =>
  slotSnapshot({ slotId: 'w1', providerId: 'web-claude', kind: 'web', status });
const cli = slotSnapshot({ slotId: 'c1', providerId: 'claude', kind: 'claude', status: 'running' });

beforeEach(() => {
  sessionStorage.clear();
});

describe('a web slot of the wall’s own ask', () => {
  test('nothing happens while it is queued; when the server starts it, the frame is asked once', async () => {
    const { runner } = harness();
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);

    runner.follow('ask-1', 'What is a monad?', [cli, web('queued')]);
    expect(runs).toHaveLength(0);
    runner.follow('ask-1', 'What is a monad?', [cli, web('running')]);
    runner.follow('ask-1', 'What is a monad?', [cli, web('running')]);
    await settle();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.options).toMatchObject({ prompt: 'What is a monad?', fill: true, read: true });
  });

  test('the finished answer is submitted as the slot’s one result', async () => {
    const { runner, submitted } = harness();
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);
    runner.follow('ask-1', 'hi', [web('running')]);
    await settle();

    runs[0]?.options.onStage?.('answering');
    expect(runner.note('w1')).toEqual({ kind: 'stage', stage: 'answering' });
    runs[0]?.finish({ outcome: 'done', text: 'A monad is a monoid…' });
    await settle();
    expect(submitted).toEqual([
      { askId: 'ask-1', slotId: 'w1', result: { outcome: 'done', text: 'A monad is a monoid…' } },
    ]);
    expect(runner.note('w1')).toBeUndefined();
  });

  test('"fill in the prompt" off: the frame is told not to type', async () => {
    const { runner } = harness({ enabled: true, fillPrompt: false, readAnswer: true });
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);
    runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    expect(runs[0]?.options).toMatchObject({ fill: false, read: true });
  });

  test('a rule that failed ends the slot as failed, with words that say nothing was stored', async () => {
    const { runner, submitted } = harness();
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);
    runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    runs[0]?.finish({ outcome: 'failed', code: 'bad_output', detail: 'input' });
    await settle();
    expect(submitted[0]?.result).toEqual({
      outcome: 'failed',
      code: 'bad_output',
      message: t('wall.web.failure.input'),
    });
    expect(t('wall.web.failure.input')).toContain('Nothing was stored');
    expect(t('wall.web.failure.input')).toContain('by hand');
  });

  test('a cell without a frame fails as unsupported instead of waiting for the timeout', async () => {
    const { runner, submitted } = harness();
    runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    expect(submitted[0]?.result).toMatchObject({ outcome: 'failed', code: 'unsupported' });
  });

  test('a slot that ended on the server (cancel, timeout) stops the frame and submits nothing', async () => {
    for (const ending of ['cancelled', 'timeout', 'error'] as const) {
      sessionStorage.clear();
      const { runner, submitted } = harness();
      const { frame, runs } = fakeFrame();
      runner.register('w1', frame);
      runner.follow('ask-1', 'hi', [web('running')]);
      await settle();
      runner.follow('ask-1', 'hi', [web(ending)]);
      await settle();
      expect(runs[0]?.options.signal.aborted, ending).toBe(true);
      expect(submitted, ending).toEqual([]);
    }
  });

  test('a frame that goes away mid-run cancels the slot with the reason', async () => {
    const { runner, submitted } = harness();
    const { frame } = fakeFrame();
    const unregister = runner.register('w1', frame);
    runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    // What the cell does when it is removed from the wall.
    unregister();
    frame.dispose();
    await settle();
    expect(submitted[0]?.result).toEqual({
      outcome: 'cancelled',
      reason: t('wall.web.reason.closed'),
    });
  });

  test('after a reload the prompt is not typed again: the slot is cancelled with the reason', async () => {
    const first = harness();
    const before = fakeFrame();
    first.runner.register('w1', before.frame);
    first.runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    expect(JSON.parse(sessionStorage.getItem(WEB_RUNS_KEY) ?? 'null')).toEqual({
      askId: 'ask-1',
      slotIds: ['w1'],
    });

    // The page was reloaded: a new runner, a new frame, the same running slot.
    const second = harness();
    const after = fakeFrame();
    second.runner.register('w1', after.frame);
    second.runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    expect(after.runs).toHaveLength(0);
    expect(second.submitted[0]?.result).toEqual({
      outcome: 'cancelled',
      reason: t('wall.web.reason.reloaded'),
    });
  });

  test('a slot that was still queued at the reload runs normally afterwards', async () => {
    const { runner } = harness();
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);
    runner.follow('ask-1', 'hi', [web('queued')]);
    const reloaded = harness();
    reloaded.runner.register('w1', frame);
    reloaded.runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    expect(runs).toHaveLength(1);
  });

  test('slots the server runs itself are never touched', async () => {
    const { runner, submitted } = harness();
    const { frame, runs } = fakeFrame();
    runner.register('c1', frame);
    runner.follow('ask-1', 'hi', [cli]);
    await settle();
    expect(runs).toHaveLength(0);
    expect(submitted).toEqual([]);
  });
});

describe('submitting the result', () => {
  async function submitWith(answer: (result: WebResultRequest) => Promise<void>) {
    const context = harness(undefined, answer);
    const { frame, runs } = fakeFrame();
    context.runner.register('w1', frame);
    context.runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    runs[0]?.finish({ outcome: 'done', text: 'answer' });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await settle();
    return context;
  }

  test('"conflict" means the slot ended some other way: nothing is reported', async () => {
    const { submitted, errors } = await submitWith(async () => {
      throw new ApiError('conflict', 409, 'ended');
    });
    expect(submitted).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a lost connection is retried with the same result', async () => {
    let attempts = 0;
    const { submitted, errors } = await submitWith(async () => {
      attempts += 1;
      if (attempts < 3) throw new ApiError('network', 0, 'offline');
    });
    expect(submitted.map((call) => call.result)).toEqual([
      { outcome: 'done', text: 'answer' },
      { outcome: 'done', text: 'answer' },
      { outcome: 'done', text: 'answer' },
    ]);
    expect(errors).toEqual([]);
  });

  test('any other failure is shown to the user once', async () => {
    const { submitted, errors } = await submitWith(async () => {
      throw new ApiError('forbidden', 403, 'reading answers is off');
    });
    expect(submitted).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test('an answer larger than the server takes in one request is cut and says so', async () => {
    const context = harness();
    const { frame, runs } = fakeFrame();
    context.runner.register('w1', frame);
    context.runner.follow('ask-1', 'hi', [web('running')]);
    await settle();
    runs[0]?.finish({ outcome: 'done', text: '字'.repeat(5_000) });
    await settle();
    const result = context.submitted[0]?.result;
    if (result?.outcome !== 'done') throw new Error('no answer was submitted');
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(4_096);
    expect(result.text.endsWith(t('wall.web.cut'))).toBe(true);
    expect(result.text.startsWith('字字字')).toBe(true);
  });
});

describe('fitting an answer into a request', () => {
  test('an answer that fits is not changed', () => {
    expect(fitAnswer('short', 4_096, '[cut]')).toBe('short');
  });

  test('a cut never splits a character, and counts what JSON adds', () => {
    // Quotes and line breaks double in JSON; emoji are two code units.
    const text = '"\n😀'.repeat(400);
    const cut = fitAnswer(text, 1_024, '[cut]');
    expect(cut.endsWith('\n\n[cut]')).toBe(true);
    expect(utf8Bytes(JSON.stringify(cut))).toBeLessThanOrEqual(1_024 - 512);
    const body = cut.slice(0, -'\n\n[cut]'.length);
    expect(text.startsWith(body)).toBe(true);
    // No lone half of a surrogate pair at the end.
    expect(body).toBe(body.toWellFormed());
  });
});

describe('reading answers off', () => {
  test('the prompt is typed in each cell and the cell says that nothing is stored', async () => {
    const { runner, submitted } = harness({ enabled: true, fillPrompt: true, readAnswer: false });
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);
    runner.fillOnly(['w1'], 'hi');
    await settle();
    expect(runs[0]?.options).toMatchObject({ prompt: 'hi', fill: true, read: false });
    runs[0]?.options.onStage?.('filling');
    expect(runner.note('w1')).toEqual({ kind: 'stage', stage: 'filling' });
    runs[0]?.finish({ outcome: 'submitted' });
    await settle();
    expect(runner.note('w1')).toEqual({ kind: 'sent' });
    expect(submitted).toEqual([]);
  });

  test('a rule failure is shown in the cell; there is no slot to fail', async () => {
    const { runner, submitted } = harness({ enabled: true, fillPrompt: true, readAnswer: false });
    const { frame, runs } = fakeFrame();
    runner.register('w1', frame);
    runner.fillOnly(['w1', 'w2'], 'hi');
    await settle();
    runs[0]?.finish({ outcome: 'failed', code: 'bad_output', detail: 'submit' });
    await settle();
    expect(runner.note('w1')).toEqual({ kind: 'failed', detail: 'submit' });
    // A cell whose frame is not there.
    expect(runner.note('w2')).toEqual({ kind: 'failed', detail: 'no_connection' });
    expect(submitted).toEqual([]);
  });
});
