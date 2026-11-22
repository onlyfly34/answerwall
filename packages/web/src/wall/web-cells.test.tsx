/**
 * Web cells on the wall: on a page that can frame the sites (the extension's
 * wall page, here a fake host) and on every other page (the server's own,
 * the desktop app, a phone), which shows a notice and the stored answers.
 */
import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createDefaultSettings } from '@answerwall/core/protocol';
import type { Settings, WebCellsSettings } from '@answerwall/core/protocol';
import { hrefOf, keepRoutesInFragment, ROUTES } from '../contracts/routes.ts';
import type {
  WebCellConnection,
  WebCellHost,
  WebCellRunOptions,
  WebCellRunResult,
} from '../contracts/services.ts';
import { createFakeServices } from '../contracts/testing.ts';
import type { FakeServices } from '../contracts/testing.ts';
import { viewAskHref } from './navigation.ts';
import { ARRANGEMENT_KEY } from './state/wall-state.ts';
import { askSnapshot, mountPages, settle, slotSnapshot } from './test-support.tsx';

const SITE_URL = 'https://claude.ai/new';

function settingsWith(webCells: Partial<WebCellsSettings>): Settings {
  const settings = createDefaultSettings();
  return {
    ...settings,
    webCells: { ...settings.webCells, enabled: true, ...webCells },
    providers: [
      ...settings.providers.filter((provider) => provider.id === 'claude'),
      {
        id: 'web-claude',
        kind: 'web',
        site: 'claude',
        label: 'Claude (web)',
        enabled: true,
        concurrency: 2,
        models: [],
      },
    ],
  };
}

interface FakeHost extends WebCellHost {
  runs: { options: WebCellRunOptions; finish(result: WebCellRunResult): void }[];
  attached: HTMLIFrameElement[];
  disposed: number;
  setConnection(connection: WebCellConnection): void;
}

function fakeHost(verified = false): FakeHost {
  const [connection, setConnection] = createSignal<WebCellConnection>('loading');
  const host: FakeHost = {
    runs: [],
    attached: [],
    disposed: 0,
    setConnection,
    site: (site) => (site === 'claude' ? { url: SITE_URL, verified } : undefined),
    attach(frame) {
      host.attached.push(frame);
      return {
        connection,
        run: (options) =>
          new Promise((resolve) => {
            host.runs.push({ options, finish: resolve });
            options.signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }));
          }),
        dispose: () => {
          host.disposed += 1;
        },
      };
    },
  };
  return host;
}

/** The wall with one CLI cell and one web cell, as a preset would leave it. */
async function mountWall(
  webCells: Partial<WebCellsSettings>,
  host?: FakeHost,
  url: string = ROUTES.wall,
  api: Parameters<typeof createFakeServices>[0] = {},
): Promise<FakeServices> {
  sessionStorage.setItem(
    ARRANGEMENT_KEY,
    JSON.stringify({
      slots: [
        { slotId: 'c1', providerId: 'claude' },
        { slotId: 'w1', providerId: 'web-claude' },
      ],
      layout: null,
      maximised: null,
      presetId: null,
      prompt: '',
      askId: null,
    }),
  );
  const services = createFakeServices({
    settings: settingsWith(webCells),
    api: {
      listPresets: async () => [],
      submitWebResult: async () => ({ status: 'done', truncated: false }),
    },
    ...(host ? { webCells: host } : {}),
    ...api,
  });
  mountPages(url, services);
  await screen.findByRole('heading', { name: 'Wall' });
  await settle();
  return services;
}

const cell = (slotId: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`.wall-cell[data-slot-id="${slotId}"]`);
  if (!found) throw new Error(`no cell ${slotId}`);
  return found;
};
const status = (slotId: string): string | null | undefined =>
  cell(slotId).querySelector('.wall-cell-status')?.textContent;
const prompt = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Prompt');
const sendButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^Send to \d+$/ });

async function send(text: string): Promise<void> {
  fireEvent.input(prompt(), { target: { value: text } });
  fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true });
  await settle();
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  keepRoutesInFragment(false);
});

describe('on a page that cannot frame a site', () => {
  test('a web cell says where it lives, shows no frame and is left out of the ask', async () => {
    const services = await mountWall({ fillPrompt: true, readAnswer: true });
    expect(cell('w1').textContent).toContain(
      'works only on the wall page of the browser extension',
    );
    expect(cell('w1').querySelector('iframe')).toBeNull();
    expect(within(cell('w1')).getByRole('link', { name: 'Open Providers' })).toBeTruthy();

    expect(sendButton().textContent).toBe('Send to 1');
    await send('hello');
    expect(services.asks.submitted).toEqual([
      { prompt: 'hello', targets: [{ slotId: 'c1', providerId: 'claude' }] },
    ]);
  });

  test('the provider picker lists the web app but does not offer it', async () => {
    await mountWall({});
    const option = within(cell('c1'))
      .getAllByRole<HTMLOptionElement>('option')
      .find((candidate) => candidate.value === 'web-claude');
    expect(option?.disabled).toBe(true);
    expect(option?.textContent).toBe('Claude (web) (browser extension only)');
  });

  test('a fresh wall gets no web cell, and "Add cell" never adds one', async () => {
    const services = createFakeServices({
      settings: settingsWith({}),
      api: { listPresets: async () => [] },
    });
    mountPages(ROUTES.wall, services);
    await screen.findByRole('heading', { name: 'Wall' });
    await settle();
    const ids = (): string[] =>
      Array.from(document.querySelectorAll<HTMLSelectElement>('.wall-cell select'))
        .filter((select) => select.closest('label')?.textContent?.includes('Provider'))
        .map((select) => select.value);
    expect(ids()).toEqual(['claude']);
    fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    expect(ids()).toEqual(['claude', 'claude']);
  });

  test('a past ask shows the stored answer of its web slot like any other answer', async () => {
    const past = askSnapshot([
      slotSnapshot({
        slotId: 'w1',
        providerId: 'web-claude',
        kind: 'web',
        status: 'done',
        text: 'Read from the **page**.',
      }),
    ]);
    await mountWall({}, undefined, viewAskHref(past.askId), {
      api: { listPresets: async () => [], getHistoryEntry: async () => past },
    });
    await settle();
    expect(cell('w1').querySelector('.wall-markdown strong')?.textContent).toBe('page');
    expect(cell('w1').querySelector('.wall-cell-name')?.textContent).toBe('Claude (web)');
  });
});

describe('on the wall page of the extension', () => {
  test('a web cell is a frame of the site, with its name, state, reload and a link to a tab', async () => {
    const host = fakeHost();
    await mountWall({ fillPrompt: true, readAnswer: true }, host);

    const frame = cell('w1').querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(SITE_URL);
    expect(frame?.title).toBe('Claude (web) (web page)');
    expect(host.attached).toEqual([frame]);
    expect(cell('w1').querySelector('.wall-cell-name')?.textContent).toBe('Claude (web)');
    // No model to pick: the site chooses it in its own page.
    expect(within(cell('w1')).queryByLabelText('Model')).toBeNull();
    expect(within(cell('c1')).getByLabelText('Model')).toBeTruthy();

    const connection = within(cell('w1')).getByTestId('web-connection');
    expect(connection.textContent).toBe('Connecting to the page…');
    host.setConnection('ready');
    expect(connection.textContent).toBe('Connected to the page');
    host.setConnection('unreachable');
    expect(connection.textContent).toContain('No connection to the page');

    const tab = within(cell('w1')).getByRole<HTMLAnchorElement>('link', {
      name: 'Open Claude (web) in a tab',
    });
    expect(tab.getAttribute('href')).toBe(SITE_URL);
    expect(tab.target).toBe('_blank');

    // Reload sends the frame to the site's address again.
    frame?.setAttribute('src', 'https://claude.ai/chat/123');
    fireEvent.click(within(cell('w1')).getByRole('button', { name: 'Reload Claude (web)' }));
    expect(frame?.getAttribute('src')).toBe(SITE_URL);
  });

  test('a rule that was not checked by hand is marked; a checked one is not', async () => {
    await mountWall({}, fakeHost(false));
    expect(within(cell('w1')).getByText('Unverified rule').title).toContain(
      'has not been checked by hand',
    );
    cleanup();
    await mountWall({}, fakeHost(true));
    expect(within(cell('w1')).queryByText('Unverified rule')).toBeNull();
  });

  test('both switches on: the ask carries the web slot, and its frame runs when the server starts it', async () => {
    const host = fakeHost();
    const services = await mountWall({ fillPrompt: true, readAnswer: true }, host);
    expect(sendButton().textContent).toBe('Send to 2');
    await send('What is a monad?');

    expect(services.asks.submitted).toEqual([
      {
        prompt: 'What is a monad?',
        targets: [
          { slotId: 'c1', providerId: 'claude' },
          { slotId: 'w1', providerId: 'web-claude' },
        ],
        runsWebSlots: true,
      },
    ]);
    // Queued: the frame is left alone until the server gives the slot its turn.
    expect(host.runs).toHaveLength(0);
    const stream = services.asks.current();
    stream?.apply({
      type: 'start',
      seq: 1,
      slotId: 'w1',
      providerId: 'web-claude',
      streaming: 'block',
      at: 1,
    });
    await settle();
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0]?.options).toMatchObject({
      prompt: 'What is a monad?',
      fill: true,
      read: true,
    });
    expect(status('w1')).toBe('Starting…');
    host.runs[0]?.options.onStage?.('answering');
    expect(status('w1')).toBe('Waiting for the page to finish its answer…');

    host.runs[0]?.finish({ outcome: 'done', text: 'A monad is…' });
    await settle();
    const calls = services.apiCalls.filter((call) => call.method === 'submitWebResult');
    expect(calls.map((call) => call.args)).toEqual([
      ['ask-1', 'w1', { outcome: 'done', text: 'A monad is…' }],
    ]);

    // What the server then sends to every device.
    stream?.apply({
      type: 'delta',
      seq: 2,
      slotId: 'w1',
      providerId: 'web-claude',
      text: 'A monad is…',
    });
    stream?.apply({ type: 'done', seq: 3, slotId: 'w1', providerId: 'web-claude', elapsedMs: 900 });
    expect(status('w1')).toBe('Done. The answer is stored in history.');
    // The cell keeps showing the site, not a copy of the answer.
    expect(cell('w1').querySelector('iframe')).not.toBeNull();
    expect(cell('w1').querySelector('.wall-markdown')).toBeNull();
  });

  test('a failed rule shows the reason in the cell, and the frame stays', async () => {
    const host = fakeHost();
    const services = await mountWall({ fillPrompt: true, readAnswer: true }, host);
    await send('hi');
    const stream = services.asks.current();
    stream?.apply({
      type: 'start',
      seq: 1,
      slotId: 'w1',
      providerId: 'web-claude',
      streaming: 'block',
      at: 1,
    });
    await settle();
    host.runs[0]?.finish({ outcome: 'failed', code: 'bad_output', detail: 'input' });
    await settle();
    const submitted = services.apiCalls.find((call) => call.method === 'submitWebResult');
    expect(submitted?.args[2]).toMatchObject({ outcome: 'failed', code: 'bad_output' });

    stream?.apply({
      type: 'error',
      seq: 2,
      slotId: 'w1',
      providerId: 'web-claude',
      code: 'bad_output',
      message: 'The site rule did not find the message box.',
      elapsedMs: 10,
    });
    expect(within(cell('w1')).getByRole('alert').textContent).toContain(
      'did not find the message box',
    );
    expect(cell('w1').querySelector('iframe')).not.toBeNull();
    expect(host.disposed).toBe(0);
  });

  test('"read the answer" off: the ask has no web slot; the prompt is typed in and nothing is stored', async () => {
    const host = fakeHost();
    const services = await mountWall({ fillPrompt: true, readAnswer: false }, host);
    expect(sendButton().textContent).toBe('Send to 2');
    await send('hi');
    expect(services.asks.submitted).toEqual([
      { prompt: 'hi', targets: [{ slotId: 'c1', providerId: 'claude' }] },
    ]);
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0]?.options).toMatchObject({ prompt: 'hi', fill: true, read: false });
    host.runs[0]?.finish({ outcome: 'submitted' });
    await settle();
    expect(status('w1')).toBe('Sent in the page. Reading answers is off, so nothing is stored.');
    expect(services.apiCalls.some((call) => call.method === 'submitWebResult')).toBe(false);
  });

  test('"fill in the prompt" off: the slot waits for the user to type in the page', async () => {
    const host = fakeHost();
    const services = await mountWall({ fillPrompt: false, readAnswer: true }, host);
    await send('hi');
    expect(services.asks.submitted[0]?.runsWebSlots).toBe(true);
    services.asks.current()?.apply({
      type: 'start',
      seq: 1,
      slotId: 'w1',
      providerId: 'web-claude',
      streaming: 'block',
      at: 1,
    });
    await settle();
    expect(host.runs[0]?.options).toMatchObject({ fill: false, read: true });
    host.runs[0]?.options.onStage?.('awaiting_hand');
    expect(status('w1')).toContain('Type and send the prompt in the page');
  });

  test('both switches off: the cell says so and takes no part in an ask', async () => {
    const host = fakeHost();
    const services = await mountWall({ fillPrompt: false, readAnswer: false }, host);
    expect(status('w1')).toBe('Filling in and reading are off: use the page by hand.');
    expect(sendButton().textContent).toBe('Send to 1');
    await send('hi');
    expect(services.asks.submitted[0]?.targets).toEqual([{ slotId: 'c1', providerId: 'claude' }]);
    expect(host.runs).toHaveLength(0);

    // Nothing but the web cell left: there is nobody to send to.
    fireEvent.click(within(cell('c1')).getByRole('button', { name: /^Remove/ }));
    fireEvent.input(prompt(), { target: { value: 'again' } });
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector('#wall-composer-hint')?.textContent).toContain(
      'Use them by hand',
    );
  });

  test('cancelling the slot stops the run without submitting a result', async () => {
    const host = fakeHost();
    const services = await mountWall({ fillPrompt: true, readAnswer: true }, host);
    await send('hi');
    const stream = services.asks.current();
    stream?.apply({
      type: 'start',
      seq: 1,
      slotId: 'w1',
      providerId: 'web-claude',
      streaming: 'block',
      at: 1,
    });
    await settle();
    fireEvent.click(within(cell('w1')).getByRole('button', { name: 'Cancel Claude (web)' }));
    expect(services.asks.cancelled).toEqual(['w1']);
    stream?.apply({
      type: 'cancelled',
      seq: 2,
      slotId: 'w1',
      providerId: 'web-claude',
      elapsedMs: 5,
    });
    await settle();
    expect(host.runs[0]?.options.signal.aborted).toBe(true);
    expect(services.apiCalls.some((call) => call.method === 'submitWebResult')).toBe(false);
    expect(cell('w1').querySelector('iframe')).not.toBeNull();
  });

  test('removing the cell disposes of its frame', async () => {
    const host = fakeHost();
    await mountWall({}, host);
    fireEvent.click(within(cell('w1')).getByRole('button', { name: /^Remove/ }));
    expect(host.disposed).toBe(1);
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('plain links to a route', () => {
  test('point into the fragment on a page that keeps its routes there', () => {
    expect(hrefOf(ROUTES.history)).toBe('/history');
    expect(viewAskHref('ask-1')).toBe('/?ask=ask-1');
    keepRoutesInFragment();
    expect(hrefOf(ROUTES.history)).toBe('#/history');
    expect(viewAskHref('ask-1')).toBe('#/?ask=ask-1');
  });
});
