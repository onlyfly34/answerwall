import { beforeEach, describe, expect, test } from 'vitest';
import type { WebCellStage } from '@answerwall/web/embed';
import type { SiteRule } from '../rules/schema.ts';
import { answersOf, fillInput, isSignedOut, readAnswer, runRule, textOf } from './engine.ts';
import type { EngineEnvironment, EngineTiming } from './engine.ts';

const RULE: SiteRule = {
  site: 'standin',
  host: 'vendor.localhost',
  start: '/',
  verified: true,
  verifiedOn: '2026-01-01',
  notes: '',
  signedOut: { paths: ['/login'], selectors: ['[data-testid="signed-out"]'] },
  input: { selectors: ['#missing-first', '#prompt'] },
  submit: { selectors: ['#send'], enterKey: false },
  answer: { selectors: ['#answers .answer'], content: ['.text'], strip: ['button'] },
  finished: {
    busy: ['#stop'],
    done: ['[data-state="done"]'],
    failed: ['[data-state="failed"]'],
    quietMs: 300,
  },
};

const TIMING: EngineTiming = {
  pollMs: 100,
  inputMs: 1_000,
  submitMs: 500,
  appearMs: 2_000,
  emptyMs: 1_000,
  editorMs: 100,
};

/** A clock that only moves when the engine sleeps; `at` schedules what the page does meanwhile. */
function virtualTime() {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  const at = (ms: number, run: () => void): void => {
    due.push({ at: now + ms, run });
  };
  const sleep = async (ms: number): Promise<void> => {
    now += ms;
    for (const item of due.splice(0).sort((a, b) => a.at - b.at)) {
      if (item.at <= now) item.run();
      else due.push(item);
    }
    await Promise.resolve();
  };
  return { now: () => now, at, sleep };
}

interface Site {
  environment: EngineEnvironment;
  time: ReturnType<typeof virtualTime>;
  prompts: string[];
  setPath(path: string): void;
  /** What the site answers, and how: a list of [delay, text chunk]. */
  script: { chunks: [number, string][]; ending: 'done' | 'failed' | 'never'; busyButton: boolean };
}

/** A page that behaves like a chat app: its button wakes on `input` events, its answer streams. */
function site(body: string, rich = false): Site {
  document.body.innerHTML = body;
  const time = virtualTime();
  const prompts: string[] = [];
  let path = '/';
  const script: Site['script'] = {
    chunks: [
      [100, 'Hello '],
      [100, 'world'],
    ],
    ending: 'done',
    busyButton: false,
  };
  const input = document.querySelector<HTMLElement>('#prompt');
  const send = document.querySelector<HTMLButtonElement>('#send');
  const answers = document.querySelector('#answers');
  let seen = '';
  input?.addEventListener('input', () => {
    seen = rich ? (input.textContent ?? '') : (input as HTMLTextAreaElement).value;
    if (send) send.disabled = seen.trim() === '';
  });
  const submit = (): void => {
    if (!answers) return;
    prompts.push(seen);
    const answer = document.createElement('div');
    answer.className = 'answer';
    answer.dataset['state'] = 'streaming';
    answer.innerHTML = '<p class="text"></p><button>Copy</button>';
    if (script.busyButton)
      answers.insertAdjacentHTML('afterend', '<button id="stop">Stop</button>');
    let delay = 0;
    time.at(50, () => answers.append(answer));
    for (const [wait, chunk] of script.chunks) {
      delay += wait;
      time.at(50 + delay, () => {
        const text = answer.querySelector('.text');
        if (text) text.textContent += chunk;
      });
    }
    if (script.ending !== 'never') {
      time.at(50 + delay + 100, () => {
        answer.dataset['state'] = script.ending;
        document.querySelector('#stop')?.remove();
      });
    }
  };
  send?.addEventListener('click', submit);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  return {
    environment: {
      document,
      pathname: () => path,
      now: time.now,
      sleep: time.sleep,
      timing: TIMING,
    },
    time,
    prompts,
    setPath: (next) => (path = next),
    script,
  };
}

const CHAT = `
  <div id="answers"></div>
  <textarea id="prompt"></textarea>
  <button id="send" disabled>Send</button>`;
const RICH_CHAT = `
  <div id="answers"></div>
  <div id="prompt" contenteditable="true"></div>
  <button id="send" disabled>Send</button>`;

function request(overrides: Partial<Parameters<typeof runRule>[2]> = {}) {
  const stages: WebCellStage[] = [];
  return {
    stages,
    request: {
      prompt: 'What is a monad?',
      fill: true,
      read: true,
      resume: false,
      signal: new AbortController().signal,
      onStage: (stage: WebCellStage) => void stages.push(stage),
      ...overrides,
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('filling in and reading', () => {
  test('types into a field, submits and reads the finished answer', async () => {
    const page = site(CHAT);
    const { request: run, stages } = request();
    const result = await runRule(RULE, page.environment, run);

    expect(page.prompts).toEqual(['What is a monad?']);
    expect(result).toEqual({ outcome: 'done', text: 'Hello world' });
    expect(stages).toEqual(['filling', 'answering']);
  });

  test('a rich editor is filled in through its text and an input event', async () => {
    const page = site(RICH_CHAT, true);
    const result = await runRule(RULE, page.environment, request().request);
    expect(page.prompts).toEqual(['What is a monad?']);
    expect(result).toMatchObject({ outcome: 'done' });
  });

  test('the answer is read only once the page says it has finished and the text is quiet', async () => {
    const page = site(CHAT);
    page.script.chunks = [
      [100, 'One. '],
      [900, 'Two. '],
      [900, 'Three.'],
    ];
    const result = await runRule(RULE, page.environment, request().request);
    expect(result).toEqual({ outcome: 'done', text: 'One. Two. Three.' });
    // 50 ms to appear, 1900 ms of text, then the mark and the quiet time: not
    // after the first chunk, although the text stood still for 900 ms there.
    expect(page.time.now()).toBeGreaterThanOrEqual(1_950 + RULE.finished.quietMs);
  });

  test('a "busy" element keeps a finished-looking answer from being read', async () => {
    const page = site(CHAT);
    const rule: SiteRule = { ...RULE, finished: { ...RULE.finished, done: [] } };
    page.script.busyButton = true;
    page.script.chunks = [[100, 'Early text']];
    page.script.ending = 'never';
    page.time.at(5_000, () => document.querySelector('#stop')?.remove());
    const result = await runRule(rule, page.environment, request().request);
    expect(result).toEqual({ outcome: 'done', text: 'Early text' });
    expect(page.time.now()).toBeGreaterThanOrEqual(5_000);
  });

  test('a second run reads the new answer, not the one already on the page', async () => {
    const page = site(CHAT);
    await runRule(RULE, page.environment, request().request);
    page.script.chunks = [[100, 'Second answer']];
    const result = await runRule(RULE, page.environment, request({ prompt: 'Again' }).request);
    expect(page.prompts).toEqual(['What is a monad?', 'Again']);
    expect(result).toEqual({ outcome: 'done', text: 'Second answer' });
  });

  test('without reading, the run ends as soon as the prompt is submitted', async () => {
    const page = site(CHAT);
    const { request: run, stages } = request({ read: false });
    expect(await runRule(RULE, page.environment, run)).toEqual({ outcome: 'submitted' });
    expect(page.prompts).toEqual(['What is a monad?']);
    expect(stages).toEqual(['filling']);
  });

  test('Enter is pressed when the rule allows it and no send control turns up', async () => {
    const page = site(CHAT.replace('id="send"', 'id="other"'));
    const rule: SiteRule = { ...RULE, submit: { selectors: ['#send'], enterKey: true } };
    const result = await runRule(rule, page.environment, request().request);
    expect(page.prompts).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'done' });
  });
});

describe('filling off', () => {
  test('nothing in the page is touched; the answer the user causes is read', async () => {
    const page = site(CHAT);
    const input = document.querySelector<HTMLTextAreaElement>('#prompt');
    const { request: run, stages } = request({ fill: false });
    // The user types and sends by hand, a while after the run began.
    page.time.at(3_000, () => {
      if (!input) return;
      input.value = 'My own words';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLButtonElement>('#send')?.click();
    });
    const result = await runRule(RULE, page.environment, run);
    expect(page.prompts).toEqual(['My own words']);
    expect(result).toEqual({ outcome: 'done', text: 'Hello world' });
    expect(stages).toEqual(['awaiting_hand', 'answering']);
  });

  test('resuming on a page that replaced the first one reads without typing again', async () => {
    const page = site(CHAT);
    document
      .querySelector('#answers')
      ?.insertAdjacentHTML(
        'beforeend',
        '<div class="answer" data-state="done"><p class="text">Already here</p></div>',
      );
    const { request: run, stages } = request({ resume: true });
    const result = await runRule(RULE, page.environment, run);
    expect(page.prompts).toEqual([]);
    expect(result).toEqual({ outcome: 'done', text: 'Already here' });
    expect(stages).toEqual(['answering']);
  });
});

describe('when the rule does not match', () => {
  test('no message box: the run fails as a rule failure and nothing is typed', async () => {
    const page = site('<div id="answers"></div><textarea id="composer"></textarea>');
    const result = await runRule(RULE, page.environment, request().request);
    expect(result).toEqual({ outcome: 'failed', code: 'bad_output', detail: 'input' });
    expect(document.querySelector<HTMLTextAreaElement>('#composer')?.value).toBe('');
    expect(page.time.now()).toBeGreaterThanOrEqual(TIMING.inputMs);
  });

  test('a message box that appears late is still found', async () => {
    const page = site('<div id="late"></div>');
    page.time.at(600, () => {
      document.body.innerHTML = CHAT;
      const input = document.querySelector<HTMLTextAreaElement>('#prompt');
      const send = document.querySelector<HTMLButtonElement>('#send');
      input?.addEventListener('input', () => {
        if (send) send.disabled = false;
      });
    });
    const { request: run } = request({ read: false });
    expect(await runRule(RULE, page.environment, run)).toEqual({ outcome: 'submitted' });
  });

  test('no usable send control, and the rule does not allow Enter', async () => {
    const page = site(CHAT);
    const rule: SiteRule = { ...RULE, submit: { selectors: ['#never'], enterKey: false } };
    const result = await runRule(rule, page.environment, request().request);
    expect(result).toEqual({ outcome: 'failed', code: 'bad_output', detail: 'submit' });
    expect(page.prompts).toEqual([]);
  });

  test('no answer appears after submitting', async () => {
    const page = site(CHAT.replace('id="answers"', 'id="thread"'));
    const result = await runRule(RULE, page.environment, request().request);
    expect(result).toEqual({ outcome: 'failed', code: 'bad_output', detail: 'answer' });
  });

  test('a finished answer without text', async () => {
    const page = site(CHAT);
    page.script.chunks = [];
    const result = await runRule(RULE, page.environment, request().request);
    expect(result).toEqual({ outcome: 'failed', code: 'bad_output', detail: 'empty' });
  });

  test("the site's own error is not stored as an answer", async () => {
    const page = site(CHAT);
    page.script.ending = 'failed';
    const result = await runRule(RULE, page.environment, request().request);
    expect(result).toEqual({ outcome: 'failed', code: 'unknown', detail: 'answer' });
  });

  test('the sign-in page is reported as such, by path or by content', async () => {
    const byContent = site('<h1 data-testid="signed-out">Sign in</h1>');
    expect(await runRule(RULE, byContent.environment, request().request)).toEqual({
      outcome: 'failed',
      code: 'not_logged_in',
      detail: 'signed_out',
    });

    const byPath = site(CHAT);
    byPath.setPath('/login/start');
    expect(await runRule(RULE, byPath.environment, request().request)).toMatchObject({
      code: 'not_logged_in',
    });
    expect(byPath.prompts).toEqual([]);
    expect(isSignedOut(RULE, document, '/chat')).toBe(false);
  });
});

describe('aborting', () => {
  test('an aborted run reports nothing and stops looking at the page', async () => {
    const page = site(CHAT);
    page.script.ending = 'never';
    const controller = new AbortController();
    page.time.at(1_000, () => controller.abort());
    const result = await runRule(
      RULE,
      page.environment,
      request({ signal: controller.signal }).request,
    );
    expect(result).toBeUndefined();
    expect(page.time.now()).toBeLessThan(2_000);
  });

  test('a run that is aborted before it starts types nothing', async () => {
    const page = site('<div id="answers"></div>');
    const controller = new AbortController();
    controller.abort();
    const { request: run } = request({ signal: controller.signal });
    expect(await runRule(RULE, page.environment, run)).toBeUndefined();
  });
});

describe('the parts', () => {
  test('answers are the matches of the first selector that matches at all', () => {
    document.body.innerHTML =
      '<div class="old">a</div><div class="new">b</div><div class="new">c</div>';
    const rule: SiteRule = {
      ...RULE,
      answer: { ...RULE.answer, selectors: ['.newest', '.new', '.old'] },
    };
    expect(answersOf(rule, document).map((element) => element.textContent)).toEqual(['b', 'c']);
    expect(
      answersOf({ ...rule, answer: { ...rule.answer, selectors: ['.none'] } }, document),
    ).toEqual([]);
  });

  test('reading takes the content part and leaves out what the rule strips', () => {
    document.body.innerHTML =
      '<div class="answer"><header>Model</header><div class="text"><p>Kept <button>Copy</button></p></div></div>';
    const answer = document.querySelector('.answer');
    if (!answer) throw new Error('no answer');
    expect(readAnswer(RULE, answer)).toBe('Kept');
    expect(readAnswer({ ...RULE, answer: { ...RULE.answer, content: [] } }, answer)).toBe(
      'Model\n\nKept',
    );
  });

  test('a field is set through the native setter, so a framework that tracks the property sees it', async () => {
    document.body.innerHTML = '<textarea id="prompt"></textarea>';
    const input = document.querySelector<HTMLTextAreaElement>('#prompt');
    if (!input) throw new Error('no input');
    // What React does: it shadows `value` on the element to notice its own writes.
    let tracked = '';
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => native?.get?.call(input) as string,
      set: (value: string) => {
        tracked = value;
        native?.set?.call(input, value);
      },
    });
    const events: string[] = [];
    input.addEventListener('input', (event) => {
      if (event instanceof InputEvent) events.push(event.inputType);
    });

    const time = virtualTime();
    expect(await fillInput(input, 'two\nlines', { sleep: time.sleep, timing: TIMING })).toBe(true);
    expect(textOf(input)).toBe('two\nlines');
    // The shadowing setter was bypassed: the page's own code sees a real change.
    expect(tracked).toBe('');
    expect(events).toEqual(['insertText']);
  });

  test('something that is no message box is not written to', async () => {
    document.body.innerHTML = '<div id="prompt">static</div>';
    const input = document.querySelector('#prompt');
    if (!input) throw new Error('no element');
    const time = virtualTime();
    expect(await fillInput(input, 'x', { sleep: time.sleep, timing: TIMING })).toBe(false);
    expect(input.textContent).toBe('static');
  });
});
