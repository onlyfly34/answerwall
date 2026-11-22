import { cleanup, fireEvent, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDefaultSettings } from '@answerwall/core/protocol';
import type { Preset, PresetInput, ProviderStatus, Settings } from '@answerwall/core/protocol';
import { ROUTES } from '../contracts/routes.ts';
import { ApiError } from '../contracts/services.ts';
import type { ApiClient } from '../contracts/services.ts';
import { createFakeServices, readyProviderStatus } from '../contracts/testing.ts';
import type { FakeAskStream, FakeServices, FakeServicesOptions } from '../contracts/testing.ts';
import { reaskHref, viewAskHref } from './navigation.ts';
import { ARRANGEMENT_KEY, DEFAULT_PRESET_KEY } from './state/wall-state.ts';
import {
  askSnapshot,
  mountPages,
  setViewportWidth,
  settle,
  slotSnapshot,
} from './test-support.tsx';

const DESKTOP = 1280;
const TABLET = 800;
const PHONE = 390;

/** A preset store behind the fake API. */
function presetApi(server: Preset[]): Partial<ApiClient> {
  return {
    listPresets: async () => server.map((preset) => structuredClone(preset)),
    savePreset: async (presetId: string, input: PresetInput) => {
      const saved: Preset = {
        ...structuredClone(input),
        id: presetId,
        createdAt: 1,
        updatedAt: 2,
      };
      const index = server.findIndex((preset) => preset.id === presetId);
      if (index === -1) server.push(saved);
      else server[index] = saved;
      return saved;
    },
    deletePreset: async (presetId: string) => {
      server.splice(
        server.findIndex((preset) => preset.id === presetId),
        1,
      );
    },
  };
}

async function mountWall(
  options: FakeServicesOptions = {},
  url: string = ROUTES.wall,
): Promise<FakeServices> {
  const services = createFakeServices({ api: presetApi([]), ...options });
  mountPages(url, services);
  await screen.findByRole('heading', { name: 'Wall' });
  await settle();
  return services;
}

const cells = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.wall-cell'));
const visibleCells = (): HTMLElement[] => cells().filter((cell) => !cell.hidden);
const names = (list: HTMLElement[] = cells()): (string | null | undefined)[] =>
  list.map((cell) => cell.querySelector('.wall-cell-name')?.textContent);
const statuses = (): (string | null | undefined)[] =>
  cells().map((cell) => cell.querySelector('.wall-cell-status')?.textContent);
const cellNamed = (name: string, nth = 0): HTMLElement => {
  const cell = cells().filter((candidate) => names([candidate])[0] === name)[nth];
  if (!cell) throw new Error(`no cell named ${name}`);
  return cell;
};
const grid = (): HTMLElement => screen.getByTestId('wall-grid');
/** The grid's column template; jsdom writes a zero length with its unit. */
const columns = (): string => grid().style.gridTemplateColumns.replace(/(?<!\d)0px/g, '0');
const prompt = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Prompt');
const sendButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^Send to \d+$/ });
const hint = (): string | null | undefined =>
  document.querySelector('#wall-composer-hint')?.textContent;

function type(text: string): void {
  fireEvent.input(prompt(), { target: { value: text } });
}

async function send(text: string, services: FakeServices): Promise<FakeAskStream> {
  type(text);
  fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true });
  await settle();
  const stream = services.asks.current();
  if (!stream) throw new Error('nothing was submitted');
  return stream;
}

/** Ends every unfinished slot and the ask itself. */
function finish(stream: FakeAskStream): void {
  let seq = stream.snapshot()?.seq ?? 0;
  for (const slot of stream.snapshot()?.slots ?? []) {
    if (slot.status !== 'queued' && slot.status !== 'running') continue;
    const { slotId, providerId } = slot;
    stream.apply({ type: 'cancelled', seq: ++seq, slotId, providerId, elapsedMs: 5 });
  }
  stream.apply({ type: 'ask_done', seq: seq + 1 });
}

function select(cell: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(cell).getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  setViewportWidth(DESKTOP);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a fresh wall', () => {
  test('has one cell per enabled provider and a composer', async () => {
    await mountWall();
    expect(names()).toEqual(['Claude', 'Codex', 'Grok']);
    expect(statuses()).toEqual(['No answer yet', 'No answer yet', 'No answer yet']);
    expect(sendButton().textContent).toBe('Send to 3');
    expect(columns()).toBe('repeat(auto-fill, minmax(min(100%, 360px), 1fr))');
  });

  test('without any enabled provider it points to the Providers page', async () => {
    const settings = createDefaultSettings();
    for (const provider of settings.providers) provider.enabled = false;
    await mountWall({ settings });
    expect(cells()).toEqual([]);
    const empty = document.querySelector<HTMLElement>('.wall-empty');
    if (!empty) throw new Error('no empty notice');
    expect(within(empty).getByRole('link', { name: 'Open Providers' }).getAttribute('href')).toBe(
      ROUTES.providers,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add cell' }).disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(hint()).toBe('Add a cell to send.');
  });
});

describe('composer', () => {
  test('is multiline, and Send stays disabled until there is a prompt', async () => {
    await mountWall();
    expect(prompt().tagName).toBe('TEXTAREA');
    expect(sendButton().disabled).toBe(true);
    expect(hint()).toBe('Type a prompt to send.');
    type('   \n ');
    expect(sendButton().disabled).toBe(true);
    type('line one\nline two');
    expect(sendButton().disabled).toBe(false);
    expect(hint()).toBe('Ctrl+Enter sends');
  });

  test('the shortcut hint names the key of the platform', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
    await mountWall();
    type('hi');
    expect(hint()).toBe('⌘+Enter sends');
  });

  test('Ctrl+Enter sends the prompt to every cell and clears the composer', async () => {
    const services = await mountWall();
    const stream = await send('What is a monad?', services);
    expect(services.asks.submitted).toEqual([
      {
        prompt: 'What is a monad?',
        targets: [
          { slotId: 's-1', providerId: 'claude' },
          { slotId: 's-2', providerId: 'codex' },
          { slotId: 's-3', providerId: 'grok' },
        ],
      },
    ]);
    expect(prompt().value).toBe('');
    expect(statuses()).toEqual(['Queued, position 1', 'Queued, position 1', 'Queued, position 1']);
    expect(document.querySelector('.wall-asked-text')?.textContent).toBe('What is a monad?');
    expect(stream.askId).toBe('ask-1');
  });

  test('Cmd+Enter and the Send button send too; plain and Shift+Enter do not', async () => {
    const services = await mountWall();
    type('first');
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(services.asks.submitted).toHaveLength(0);

    expect(fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true })).toBe(false);
    await settle();
    expect(services.asks.submitted).toHaveLength(1);

    finish(services.asks.current() as FakeAskStream);
    type('second');
    fireEvent.click(sendButton());
    await settle();
    expect(services.asks.submitted.map((request) => request.prompt)).toEqual(['first', 'second']);
  });

  test('an Enter that confirms an input-method composition does not send', async () => {
    const services = await mountWall();
    type('你好');
    fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true, isComposing: true });
    await settle();
    expect(services.asks.submitted).toHaveLength(0);
  });

  test('the shortcut does nothing while sending is not possible', async () => {
    const services = await mountWall();
    fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true });
    await settle();
    expect(services.asks.submitted).toHaveLength(0);
  });

  test('a refused ask is reported and the prompt stays', async () => {
    const services = await mountWall();
    const failure = new ApiError('too_many_asks', 429, 'Too many asks in flight');
    services.asks.submit = async () => Promise.reject(failure);
    type('keep me');
    fireEvent.click(sendButton());
    await settle();
    expect(services.errors).toEqual([failure]);
    expect(prompt().value).toBe('keep me');
    expect(sendButton().disabled).toBe(false);
    expect(statuses()).toEqual(['No answer yet', 'No answer yet', 'No answer yet']);
  });

  test('a prompt beyond the configured size is refused before it is sent', async () => {
    const settings: Settings = createDefaultSettings();
    settings.limits.maxPromptBytes = 1024;
    const services = await mountWall({ settings });

    type('a'.repeat(700));
    expect(document.querySelector('.wall-composer-size')).toBeNull();
    type('a'.repeat(900));
    expect(document.querySelector('.wall-composer-size')?.textContent).toContain('900 B of 1.0 KB');
    expect(sendButton().disabled).toBe(false);

    // 400 characters of three bytes each: within the limit by length, beyond it by size.
    type('答'.repeat(400));
    expect(sendButton().disabled).toBe(true);
    expect(hint()).toContain('The prompt is too long.');
    expect(prompt().getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true });
    await settle();
    expect(services.asks.submitted).toHaveLength(0);
    expect(prompt().value).toBe('答'.repeat(400));
  });

  test('more cells than the limit per ask allows cannot be sent', async () => {
    const settings: Settings = createDefaultSettings();
    settings.limits.maxTargetsPerAsk = 2;
    await mountWall({ settings });
    type('hi');
    expect(sendButton().disabled).toBe(true);
    expect(hint()).toBe('3 cells exceed the limit of 2 per ask.');
  });

  test('cells of disabled or missing providers are skipped; with none left Send is disabled', async () => {
    const services = await mountWall();
    const providers = services.providers.providers();
    const disable = (ids: string[]): ProviderStatus[] =>
      providers.map((status) =>
        ids.includes(status.instance.id)
          ? { ...status, instance: { ...status.instance, enabled: false } }
          : status,
      );
    services.setProviders(disable(['codex']).filter((status) => status.instance.id !== 'grok'));
    expect(sendButton().textContent).toBe('Send to 1');
    expect(names()).toEqual(['Claude', 'Codex', 'grok']);
    const stream = await send('hello', services);
    expect(services.asks.submitted[0]?.targets).toEqual([{ slotId: 's-1', providerId: 'claude' }]);
    finish(stream);

    services.setProviders(disable(['claude', 'codex', 'grok']));
    type('again');
    expect(sendButton().disabled).toBe(true);
    expect(hint()).toBe('No cell has an enabled provider.');
  });

  test('while answers come in, Send waits and Cancel all cancels every unfinished cell', async () => {
    const services = await mountWall();
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
    const stream = await send('go', services);
    type('next');
    expect(sendButton().disabled).toBe(true);
    expect(hint()).toBe('Answers are still coming in. Wait or cancel all to ask again.');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    expect(services.asks.cancelled).toEqual([undefined]);

    finish(stream);
    expect(statuses()).toEqual(['Cancelled', 'Cancelled', 'Cancelled']);
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(prompt().value).toBe('next');
  });

  test('a failed cancel is reported', async () => {
    const services = await mountWall();
    await send('go', services);
    const failure = new ApiError('network', 0, 'offline');
    services.asks.cancel = async () => Promise.reject(failure);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    await settle();
    expect(services.errors).toEqual([failure]);
  });
});

describe('streaming', () => {
  test('each cell follows its own slot through to the end', async () => {
    const services = await mountWall();
    const stream = await send('go', services);
    const claude = { slotId: 's-1', providerId: 'claude' };
    const codex = { slotId: 's-2', providerId: 'codex' };
    const grok = { slotId: 's-3', providerId: 'grok' };

    stream.apply({ type: 'start', seq: 1, ...claude, at: Date.now(), streaming: 'token' });
    stream.apply({ type: 'start', seq: 2, ...codex, at: Date.now(), streaming: 'block' });
    expect(statuses()).toEqual([
      'Waiting for the first words',
      'Generating — this provider does not stream token by token',
      'Queued, position 1',
    ]);

    stream.apply({ type: 'delta', seq: 3, ...claude, text: 'Hello **there**' });
    stream.apply({ type: 'reasoning', seq: 4, ...claude, text: 'thinking' });
    stream.apply({
      type: 'done',
      seq: 5,
      ...claude,
      elapsedMs: 1500,
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    stream.apply({
      type: 'error',
      seq: 6,
      ...codex,
      code: 'quota',
      message: 'limit reached',
      elapsedMs: 20,
    });
    stream.apply({ type: 'timeout', seq: 7, ...grok, elapsedMs: 300_000 });
    stream.apply({ type: 'ask_done', seq: 8 });

    expect(statuses()).toEqual(['Done', 'Failed', 'Timed out']);
    const first = cellNamed('Claude');
    expect(first.querySelector('.wall-markdown strong')?.textContent).toBe('there');
    expect(within(first).getByTestId('usage').textContent).toBe('3 in · 4 out');
    expect(first.querySelector('details summary')?.textContent).toBe('Reasoning');
    expect(within(cellNamed('Codex')).getByRole('alert').textContent).toContain(
      'The quota of this provider is used up.',
    );
  });

  test('twelve cells streaming at once each render their own answer', async () => {
    const services = await mountWall();
    for (let count = 3; count < 12; count += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    }
    expect(cells()).toHaveLength(12);
    const stream = await send('go', services);
    const targets = services.asks.submitted[0]?.targets ?? [];
    expect(targets).toHaveLength(12);

    let seq = 0;
    for (const target of targets) {
      const { slotId, providerId } = target;
      stream.apply({ type: 'start', seq: ++seq, slotId, providerId, at: 0, streaming: 'token' });
    }
    for (let round = 0; round < 20; round += 1) {
      for (const target of targets) {
        const { slotId, providerId } = target;
        stream.apply({ type: 'delta', seq: ++seq, slotId, providerId, text: `w${round} ` });
      }
    }
    for (const target of targets) {
      const { slotId, providerId } = target;
      stream.apply({ type: 'done', seq: ++seq, slotId, providerId, elapsedMs: 100 });
    }
    stream.apply({ type: 'ask_done', seq: seq + 1 });

    const expected = Array.from({ length: 20 }, (_unused, round) => `w${round}`).join(' ');
    for (const cell of cells()) {
      expect(cell.querySelector('.wall-markdown')?.textContent.trim()).toBe(expected);
    }
  });

  test('the elapsed time of a running cell ticks once a second', async () => {
    const services = await mountWall();
    const stream = await send('go', services);
    vi.useFakeTimers();
    stream.apply({
      type: 'start',
      seq: 1,
      slotId: 's-1',
      providerId: 'claude',
      at: Date.now(),
      streaming: 'token',
    });
    const elapsed = (): string | null =>
      within(cellNamed('Claude')).getByTestId('elapsed').textContent;
    expect(elapsed()).toBe('0 s');
    vi.advanceTimersByTime(3000);
    expect(elapsed()).toBe('3 s');
    stream.apply({ type: 'done', seq: 2, slotId: 's-1', providerId: 'claude', elapsedMs: 3210 });
    expect(elapsed()).toBe('3.2 s');
  });

  test('cancelling one cell cancels just that slot', async () => {
    const services = await mountWall();
    await send('go', services);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Codex' }));
    expect(services.asks.cancelled).toEqual(['s-2']);
  });

  test('a lost connection is announced while it reconnects, and when it is given up', async () => {
    const services = await mountWall();
    const stream = await send('go', services);
    stream.setConnection('reconnecting');
    expect(document.querySelector('.wall-notice')?.textContent).toBe(
      'Connection lost. Reconnecting…',
    );
    stream.setConnection('live');
    expect(document.querySelector('.wall-notice')).toBeNull();
    stream.fail(new ApiError('invalid_response', 200, 'Unexpected answer'));
    expect(document.querySelector('.wall-notice')?.textContent).toBe(
      'The answers can no longer be followed. Unexpected answer',
    );
    // What was received stays on the wall.
    expect(statuses()).toEqual(['Queued, position 1', 'Queued, position 1', 'Queued, position 1']);
  });

  test('after a reload the wall follows its ask again', async () => {
    const first = await mountWall();
    await send('go', first);
    cleanup();

    const second = await mountWall();
    const stream = second.asks.current();
    expect(stream?.askId).toBe('ask-1');
    stream?.apply({
      type: 'snapshot',
      seq: 4,
      snapshot: askSnapshot(
        [
          slotSnapshot({ status: 'running', text: 'resumed' }),
          slotSnapshot({ slotId: 's-2', providerId: 'codex', kind: 'codex' }),
          slotSnapshot({ slotId: 's-3', providerId: 'grok', kind: 'grok', status: 'done' }),
        ],
        { askId: 'ask-1', status: 'running', seq: 4 },
      ),
    });
    expect(statuses()).toEqual(['Answering', 'Queued, position 1', 'Done']);
  });

  test('an ask that no longer exists after a reload is forgotten quietly', async () => {
    const first = await mountWall();
    await send('go', first);
    cleanup();

    const second = await mountWall();
    second.asks.current()?.fail(new ApiError('not_found', 404, 'No such ask'));
    expect(second.asks.current()).toBeUndefined();
    expect(document.querySelector('.wall-notice')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(ARRANGEMENT_KEY) ?? '{}')).toMatchObject({
      askId: null,
    });
  });
});

describe('cells', () => {
  test('a cell is added with the provider of the last cell, any number of times', async () => {
    const services = await mountWall();
    fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    expect(names()).toEqual(['Claude', 'Codex', 'Grok', 'Grok', 'Grok']);
    await send('hi', services);
    const slotIds = services.asks.submitted[0]?.targets.map((target) => target.slotId) ?? [];
    expect(new Set(slotIds).size).toBe(5);
  });

  test('the same provider answers with different models and efforts side by side', async () => {
    const providers = createDefaultSettings().providers.map(readyProviderStatus);
    const claude = providers[0];
    if (!claude) throw new Error('no provider');
    claude.models = [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }, { id: 'haiku' }];
    const services = await mountWall({ providers });

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Claude' }));
    expect(names()).toEqual(['Claude', 'Claude', 'Codex', 'Grok']);
    select(cellNamed('Claude', 0), 'Model', 'opus');
    expect(within(cellNamed('Claude', 0)).getByRole('option', { name: 'Opus' })).toBeDefined();
    select(cellNamed('Claude', 0), 'Effort', 'high');
    select(cellNamed('Claude', 1), 'Model', 'haiku');
    expect(within(cellNamed('Claude', 1)).queryByLabelText('Effort')).toBeNull();

    await send('hi', services);
    const targets = services.asks.submitted[0]?.targets ?? [];
    expect(targets.slice(0, 2).map(({ slotId: _slotId, ...rest }) => rest)).toEqual([
      { providerId: 'claude', model: 'opus', effort: 'high' },
      { providerId: 'claude', model: 'haiku' },
    ]);
  });

  test('a duplicate copies provider, model and effort and sits next to its original', async () => {
    const providers = createDefaultSettings().providers.map(readyProviderStatus);
    const claude = providers[0];
    if (!claude) throw new Error('no provider');
    claude.models = [{ id: 'opus', efforts: ['low', 'high'] }];
    const services = await mountWall({ providers });
    select(cellNamed('Claude'), 'Model', 'opus');
    select(cellNamed('Claude'), 'Effort', 'low');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Claude' }));
    await send('hi', services);
    const [first, second] = services.asks.submitted[0]?.targets ?? [];
    expect(second).toEqual({ ...first, slotId: second?.slotId });
    expect(second?.slotId).not.toBe(first?.slotId);
  });

  test('changing the model clears the effort; choosing the default clears the model', async () => {
    const providers = createDefaultSettings().providers.map(readyProviderStatus);
    const claude = providers[0];
    if (!claude) throw new Error('no provider');
    claude.models = [
      { id: 'opus', efforts: ['low', 'high'] },
      { id: 'sonnet', efforts: ['max'] },
    ];
    const services = await mountWall({ providers });
    select(cellNamed('Claude'), 'Model', 'opus');
    select(cellNamed('Claude'), 'Effort', 'high');
    select(cellNamed('Claude'), 'Model', 'sonnet');
    select(cellNamed('Claude'), 'Model', '');
    await send('hi', services);
    expect(services.asks.submitted[0]?.targets[0]).toEqual({ slotId: 's-1', providerId: 'claude' });
  });

  test('the provider picker lists every provider with the reason one is unavailable', async () => {
    const providers = createDefaultSettings().providers.map(readyProviderStatus);
    const grok = providers.find((status) => status.instance.id === 'grok');
    if (!grok) throw new Error('no provider');
    grok.detection = { installed: true, loggedIn: 'no', streaming: 'token' };
    await mountWall({ providers });
    const picker = within(cellNamed('Claude')).getByLabelText<HTMLSelectElement>('Provider');
    const options = Array.from(picker.options);
    expect(options.map((option) => option.textContent)).toEqual([
      'Claude',
      'Codex',
      'Gemini (agy) (disabled)',
      'Grok (not logged in)',
    ]);
    expect(options.map((option) => option.disabled)).toEqual([false, false, true, false]);
    expect(
      within(cellNamed('Grok')).getByRole('link', { name: 'Open Providers' }).getAttribute('href'),
    ).toBe(ROUTES.providers);
  });

  test('changing the provider of a running cell cancels it and clears its answer', async () => {
    const services = await mountWall();
    const stream = await send('go', services);
    const slot = { slotId: 's-1', providerId: 'claude' };
    stream.apply({ type: 'start', seq: 1, ...slot, at: 0, streaming: 'token' });
    stream.apply({ type: 'delta', seq: 2, ...slot, text: 'from Claude' });
    select(cellNamed('Claude'), 'Provider', 'grok');
    expect(services.asks.cancelled).toEqual(['s-1']);
    expect(names()).toEqual(['Grok', 'Codex', 'Grok']);
    expect(statuses()[0]).toBe('No answer yet');
    expect(cells()[0]?.querySelector('.wall-markdown')?.textContent).toBe('');
  });

  test('removing a running cell cancels its slot; removing an idle one cancels nothing', async () => {
    const services = await mountWall();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grok' }));
    expect(names()).toEqual(['Claude', 'Codex']);
    expect(services.asks.cancelled).toEqual([]);
    await send('go', services);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex' }));
    expect(services.asks.cancelled).toEqual(['s-2']);
    expect(names()).toEqual(['Claude']);
  });

  test('the arrangement and the draft survive a reload', async () => {
    await mountWall();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex' }));
    type('unsent draft');
    cleanup();
    await mountWall();
    expect(names()).toEqual(['Claude', 'Grok']);
    expect(prompt().value).toBe('unsent draft');
  });
});

describe('layout', () => {
  const layoutGroup = (): HTMLElement => screen.getByRole('group', { name: 'Layout' });
  const mode = (): HTMLSelectElement => within(layoutGroup()).getByLabelText('Columns');

  test('a fixed column count replaces the automatic columns', async () => {
    await mountWall();
    fireEvent.change(mode(), { target: { value: 'fixed' } });
    expect(columns()).toBe('repeat(3, minmax(0, 1fr))');
    const count = within(layoutGroup()).getByLabelText<HTMLInputElement>('Count');
    fireEvent.change(count, { target: { value: '5' } });
    expect(columns()).toBe('repeat(5, minmax(0, 1fr))');
  });

  test('the minimum cell width feeds the automatic columns', async () => {
    await mountWall();
    const width = within(layoutGroup()).getByLabelText<HTMLInputElement>('Minimum width (px)');
    fireEvent.change(width, { target: { value: '520' } });
    expect(columns()).toBe('repeat(auto-fill, minmax(min(100%, 520px), 1fr))');
  });

  test('values outside the accepted range are clamped and nonsense is put back', async () => {
    await mountWall();
    const width = within(layoutGroup()).getByLabelText<HTMLInputElement>('Minimum width (px)');
    fireEvent.change(width, { target: { value: '50' } });
    expect(width.value).toBe('240');
    fireEvent.change(width, { target: { value: '' } });
    expect(width.value).toBe('240');
    fireEvent.change(mode(), { target: { value: 'fixed' } });
    const count = within(layoutGroup()).getByLabelText<HTMLInputElement>('Count');
    fireEvent.change(count, { target: { value: '40' } });
    expect(count.value).toBe('12');
    expect(columns()).toBe('repeat(12, minmax(0, 1fr))');
  });

  test('the layout of this device is separate from the shared settings and can be reset', async () => {
    const services = await mountWall();
    expect(within(layoutGroup()).queryByRole('button', { name: 'Reset layout' })).toBeNull();
    fireEvent.change(mode(), { target: { value: 'fixed' } });
    expect(services.settingsUpdates).toEqual([]);
    fireEvent.click(within(layoutGroup()).getByRole('button', { name: 'Reset layout' }));
    expect(columns()).toBe('repeat(auto-fill, minmax(min(100%, 360px), 1fr))');
  });

  test('the shared layout settings apply until the device chooses its own', async () => {
    const settings = createDefaultSettings();
    settings.layout = { mode: 'fixed', minCellWidth: 400, columns: 4 };
    await mountWall({ settings });
    expect(columns()).toBe('repeat(4, minmax(0, 1fr))');
  });

  test('a tablet defaults to two columns and follows a resize', async () => {
    setViewportWidth(TABLET);
    await mountWall();
    expect(columns()).toBe('repeat(2, minmax(0, 1fr))');
    expect(mode().value).toBe('fixed');
    setViewportWidth(DESKTOP);
    expect(columns()).toBe('repeat(auto-fill, minmax(min(100%, 360px), 1fr))');
  });

  test('maximising shows one cell at full width; restoring brings the grid back', async () => {
    await mountWall();
    fireEvent.click(screen.getByRole('button', { name: 'Maximise Codex' }));
    expect(names(visibleCells())).toEqual(['Codex']);
    expect(columns()).toBe('minmax(0, 1fr)');
    expect(cells()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Codex' }));
    expect(names(visibleCells())).toEqual(['Claude', 'Codex', 'Grok']);
    expect(columns()).toContain('auto-fill');
  });

  test('a maximised cell keeps streaming, and so do the hidden ones', async () => {
    const services = await mountWall();
    const stream = await send('go', services);
    fireEvent.click(screen.getByRole('button', { name: 'Maximise Claude' }));
    const grok = { slotId: 's-3', providerId: 'grok' };
    stream.apply({ type: 'start', seq: 1, ...grok, at: 0, streaming: 'token' });
    stream.apply({ type: 'delta', seq: 2, ...grok, text: 'hidden answer' });
    stream.apply({ type: 'done', seq: 3, ...grok, elapsedMs: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Restore Claude' }));
    await waitFor(() =>
      expect(cellNamed('Grok').querySelector('.wall-markdown')?.textContent.trim()).toBe(
        'hidden answer',
      ),
    );
  });
});

describe('reordering', () => {
  test('the arrow keys on a handle move the cell and announce the new place', async () => {
    const services = await mountWall();
    const handle = screen.getByRole('button', { name: 'Move Claude, position 1 of 3' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(names()).toEqual(['Codex', 'Claude', 'Grok']);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Claude moved to position 2 of 3',
    );
    await settle();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Claude, position 2 of 3');

    fireEvent.keyDown(screen.getByRole('button', { name: /^Move Claude/ }), { key: 'End' });
    expect(names()).toEqual(['Codex', 'Grok', 'Claude']);
    await send('order', services);
    expect(services.asks.submitted[0]?.targets.map((target) => target.providerId)).toEqual([
      'codex',
      'grok',
      'claude',
    ]);
  });

  test('moving keeps the cell elements, so a streaming answer is not rebuilt', async () => {
    await mountWall();
    const before = cellNamed('Claude');
    fireEvent.keyDown(screen.getByRole('button', { name: /^Move Claude/ }), { key: 'ArrowRight' });
    expect(cellNamed('Claude')).toBe(before);
  });

  describe('by dragging', () => {
    let under: Element | null = null;
    beforeEach(() => {
      under = null;
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => under,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
    });

    const pointer = (type: string, init: PointerEventInit = {}): PointerEvent =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        button: 0,
        ...init,
      });

    test('a cell dragged over another takes its place', async () => {
      await mountWall();
      const handle = screen.getByRole('button', { name: /^Move Claude/ });
      fireEvent(handle, pointer('pointerdown'));
      expect(cellNamed('Claude').classList.contains('wall-cell-dragging')).toBe(true);

      under = cellNamed('Grok').querySelector('.wall-cell-body');
      fireEvent(window, pointer('pointermove'));
      expect(names()).toEqual(['Codex', 'Grok', 'Claude']);
      // Still over the same neighbour after the swap: no swapping back and forth.
      fireEvent(window, pointer('pointermove'));
      expect(names()).toEqual(['Codex', 'Grok', 'Claude']);

      under = cellNamed('Claude');
      fireEvent(window, pointer('pointermove'));
      under = cellNamed('Codex');
      fireEvent(window, pointer('pointermove'));
      expect(names()).toEqual(['Claude', 'Codex', 'Grok']);

      fireEvent(window, pointer('pointerup'));
      expect(cellNamed('Claude').classList.contains('wall-cell-dragging')).toBe(false);
      under = cellNamed('Grok');
      fireEvent(window, pointer('pointermove'));
      expect(names()).toEqual(['Claude', 'Codex', 'Grok']);
    });

    test('a cancelled pointer ends the drag; other buttons and secondary pointers never start one', async () => {
      await mountWall();
      const handle = screen.getByRole('button', { name: /^Move Claude/ });
      fireEvent(handle, pointer('pointerdown', { button: 2 }));
      fireEvent(handle, pointer('pointerdown', { isPrimary: false }));
      expect(document.querySelector('.wall-cell-dragging')).toBeNull();

      fireEvent(handle, pointer('pointerdown'));
      fireEvent(window, pointer('pointercancel'));
      under = cellNamed('Grok');
      fireEvent(window, pointer('pointermove'));
      expect(names()).toEqual(['Claude', 'Codex', 'Grok']);
    });

    test('a drag over empty space moves nothing', async () => {
      await mountWall();
      fireEvent(screen.getByRole('button', { name: /^Move Claude/ }), pointer('pointerdown'));
      under = document.body;
      fireEvent(window, pointer('pointermove'));
      expect(names()).toEqual(['Claude', 'Codex', 'Grok']);
    });
  });
});

describe('phone', () => {
  const tabs = (): HTMLElement[] => screen.getAllByRole('tab');
  const selectedTab = (): string | null | undefined =>
    tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;
  const dots = (): HTMLElement[] =>
    within(screen.getByRole('group', { name: 'Status of every cell' })).getAllByRole('button');
  const pointer = (type: string, x: number, y: number): PointerEvent =>
    new PointerEvent(type, {
      bubbles: true,
      isPrimary: true,
      pointerId: 1,
      clientX: x,
      clientY: y,
    });
  function swipe(fromX: number, toX: number, toY = 100, target: Element = grid()): void {
    fireEvent(target, pointer('pointerdown', fromX, 100));
    fireEvent(target, pointer('pointerup', toX, toY));
  }

  beforeEach(() => setViewportWidth(PHONE));

  test('shows one cell at a time with a tab per cell and no layout controls', async () => {
    await mountWall();
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Claude', 'Codex', 'Grok']);
    expect(names(visibleCells())).toEqual(['Claude']);
    expect(screen.queryByRole('group', { name: 'Layout' })).toBeNull();
    expect(visibleCells()[0]?.getAttribute('role')).toBe('tabpanel');
    expect(tabs()[0]?.getAttribute('aria-controls')).toBe(visibleCells()[0]?.id);
    expect(screen.queryByRole('button', { name: /^Maximise/ })).toBeNull();
  });

  test('a tab, a dot and the arrow keys switch the cell', async () => {
    await mountWall();
    fireEvent.click(screen.getByRole('tab', { name: 'Grok' }));
    expect(names(visibleCells())).toEqual(['Grok']);
    expect(selectedTab()).toBe('Grok');

    fireEvent.click(dots()[1] as HTMLElement);
    expect(names(visibleCells())).toEqual(['Codex']);
    expect(dots()[1]?.getAttribute('aria-current')).toBe('true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Codex' }), { key: 'ArrowRight' });
    expect(selectedTab()).toBe('Grok');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Grok' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Grok' }), { key: 'ArrowRight' });
    expect(selectedTab()).toBe('Grok');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Grok' }), { key: 'Home' });
    expect(selectedTab()).toBe('Claude');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Claude' }), { key: 'End' });
    expect(selectedTab()).toBe('Grok');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Grok' }), { key: 'ArrowLeft' });
    expect(selectedTab()).toBe('Codex');
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  test('a horizontal swipe moves to the next or previous cell and stops at the ends', async () => {
    await mountWall();
    swipe(300, 100);
    expect(names(visibleCells())).toEqual(['Codex']);
    swipe(300, 100);
    swipe(300, 100);
    expect(names(visibleCells())).toEqual(['Grok']);
    swipe(100, 300);
    expect(names(visibleCells())).toEqual(['Codex']);
  });

  test('short, mostly vertical and in-widget movements are not swipes', async () => {
    await mountWall();
    swipe(300, 270);
    swipe(300, 200, 400);
    const picker = within(visibleCells()[0] as HTMLElement).getByLabelText('Provider');
    swipe(300, 100, 100, picker);
    expect(names(visibleCells())).toEqual(['Claude']);
  });

  test('the dot row shows the state of every cell, also the ones not on screen', async () => {
    const services = await mountWall();
    const label = (): (string | null)[] => dots().map((dot) => dot.getAttribute('aria-label'));
    const phases = (): (string | undefined)[] =>
      dots().map((dot) => dot.querySelector<HTMLElement>('.wall-dot')?.dataset.phase);
    expect(label()).toEqual(['Claude: no answer', 'Codex: no answer', 'Grok: no answer']);

    const stream = await send('go', services);
    expect(phases()).toEqual(['queued', 'queued', 'queued']);
    const claude = { slotId: 's-1', providerId: 'claude' };
    const codex = { slotId: 's-2', providerId: 'codex' };
    const grok = { slotId: 's-3', providerId: 'grok' };
    stream.apply({ type: 'start', seq: 1, ...claude, at: 0, streaming: 'token' });
    stream.apply({ type: 'start', seq: 2, ...codex, at: 0, streaming: 'token' });
    stream.apply({ type: 'delta', seq: 3, ...codex, text: 'hi' });
    expect(phases()).toEqual(['waiting', 'streaming', 'queued']);
    stream.apply({ type: 'done', seq: 4, ...codex, elapsedMs: 1 });
    stream.apply({ type: 'error', seq: 5, ...grok, code: 'network', message: '', elapsedMs: 1 });
    expect(phases()).toEqual(['waiting', 'done', 'error']);
    expect(label()).toEqual(['Claude: waiting', 'Codex: done', 'Grok: error']);
  });

  test('removing the cell on screen shows a neighbour', async () => {
    await mountWall();
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex' }));
    expect(names(visibleCells())).toEqual(['Claude']);
    expect(tabs()).toHaveLength(2);
  });
});

describe('presets', () => {
  const bar = (): HTMLElement => screen.getByRole('region', { name: 'Presets' });
  const chip = (name: RegExp | string): HTMLElement => within(bar()).getByRole('button', { name });

  async function saveAs(name: string): Promise<void> {
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save as preset' }));
    fireEvent.input(within(bar()).getByLabelText('Preset name'), { target: { value: name } });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }));
    await settle();
  }

  test('saves the cells and the layout under a name and marks it active', async () => {
    const server: Preset[] = [];
    await mountWall({ api: presetApi(server) });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grok' }));
    fireEvent.change(
      within(screen.getByRole('group', { name: 'Layout' })).getByLabelText('Columns'),
      {
        target: { value: 'fixed' },
      },
    );
    await saveAs('Pair');
    expect(server).toHaveLength(1);
    expect(server[0]).toMatchObject({
      name: 'Pair',
      slots: [
        { slotId: 's-1', providerId: 'claude' },
        { slotId: 's-2', providerId: 'codex' },
      ],
      layout: { mode: 'fixed', minCellWidth: 360, columns: 3 },
    });
    expect(chip('Pair').getAttribute('aria-pressed')).toBe('true');
  });

  test('a name is required, and saving can be abandoned', async () => {
    const server: Preset[] = [];
    await mountWall({ api: presetApi(server) });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save as preset' }));
    const save = within(bar()).getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    fireEvent.input(within(bar()).getByLabelText('Preset name'), { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Cancel' }));
    expect(within(bar()).queryByLabelText('Preset name')).toBeNull();
    expect(server).toEqual([]);
  });

  test('one click switches the whole wall to a preset', async () => {
    const server: Preset[] = [
      {
        id: 'p-1',
        name: 'Twins',
        slots: [
          { slotId: 'a', providerId: 'grok' },
          { slotId: 'b', providerId: 'grok', model: 'grok-4' },
        ],
        layout: { mode: 'fixed', minCellWidth: 360, columns: 2 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'p-2',
        name: 'Solo',
        slots: [{ slotId: 'c', providerId: 'codex' }],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    await mountWall({ api: presetApi(server) });
    expect(names()).toEqual(['Claude', 'Codex', 'Grok']);

    fireEvent.click(chip('Twins'));
    expect(names()).toEqual(['Grok', 'Grok']);
    expect(columns()).toBe('repeat(2, minmax(0, 1fr))');
    expect(chip('Twins').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(chip('Solo'));
    expect(names()).toEqual(['Codex']);
    expect(columns()).toContain('auto-fill');
    expect(chip('Twins').getAttribute('aria-pressed')).toBe('false');
  });

  test('a changed preset is marked and can be updated in place', async () => {
    const server: Preset[] = [];
    await mountWall({ api: presetApi(server) });
    await saveAs('Trio');
    expect(within(bar()).queryByRole('button', { name: 'Update “Trio”' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grok' }));
    expect(chip(/^Trio/).textContent).toContain('(modified)');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Update “Trio”' }));
    await settle();
    expect(server[0]?.slots).toHaveLength(2);
    expect(chip(/^Trio/).textContent).not.toContain('(modified)');
  });

  test('renames the active preset', async () => {
    const server: Preset[] = [];
    await mountWall({ api: presetApi(server) });
    await saveAs('Trio');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Rename' }));
    const input = within(bar()).getByLabelText<HTMLInputElement>('Preset name');
    expect(input.value).toBe('Trio');
    fireEvent.input(input, { target: { value: 'Everyone' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await settle();
    expect(server.map((preset) => preset.name)).toEqual(['Everyone']);
    expect(chip('Everyone').getAttribute('aria-pressed')).toBe('true');
  });

  test('deletes the active preset after a confirmation and keeps the cells', async () => {
    const server: Preset[] = [];
    await mountWall({ api: presetApi(server) });
    await saveAs('Trio');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete' }));
    expect(within(bar()).getByText('Delete the preset “Trio”?')).toBeDefined();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Cancel' }));
    expect(server).toHaveLength(1);

    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete' }));
    await settle();
    expect(server).toEqual([]);
    expect(within(bar()).queryByRole('button', { name: /Trio/ })).toBeNull();
    expect(names()).toEqual(['Claude', 'Codex', 'Grok']);
  });

  test('the default preset opens on a new session and can be unset', async () => {
    const server: Preset[] = [];
    await mountWall({ api: presetApi(server) });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude' }));
    await saveAs('No Claude');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Default' }));
    expect(chip(/^No Claude/).textContent).toContain('(default)');
    expect(localStorage.getItem(DEFAULT_PRESET_KEY)).toBe(JSON.stringify(server[0]?.id));

    cleanup();
    sessionStorage.clear();
    await mountWall({ api: presetApi(server) });
    expect(names()).toEqual(['Codex', 'Grok']);
    expect(chip(/^No Claude/).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(bar()).getByRole('button', { name: 'Default' }));
    expect(localStorage.getItem(DEFAULT_PRESET_KEY)).toBeNull();
    cleanup();
    sessionStorage.clear();
    await mountWall({ api: presetApi(server) });
    expect(names()).toEqual(['Claude', 'Codex', 'Grok']);
  });

  test('a failed save is reported and the name stays for another try', async () => {
    const failure = new ApiError('conflict', 409, 'Too many presets');
    const services = await mountWall({
      api: { ...presetApi([]), savePreset: async () => Promise.reject(failure) },
    });
    await saveAs('Trio');
    expect(services.errors).toEqual([failure]);
    expect(within(bar()).getByLabelText<HTMLInputElement>('Preset name').value).toBe('Trio');
  });

  test('an empty wall cannot be saved', async () => {
    await mountWall();
    for (const name of ['Claude', 'Codex', 'Grok']) {
      fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    }
    expect(
      within(bar()).getByRole<HTMLButtonElement>('button', { name: 'Save as preset' }).disabled,
    ).toBe(true);
  });
});

describe('a past ask', () => {
  const past = askSnapshot([
    slotSnapshot({
      slotId: 'h-1',
      status: 'done',
      model: 'opus',
      text: 'A monad is a **pattern**.',
      elapsedMs: 2000,
    }),
    slotSnapshot({
      slotId: 'h-2',
      providerId: 'grok',
      kind: 'grok',
      status: 'error',
      error: { code: 'not_logged_in', message: '' },
    }),
  ]);

  test('opens read-only on the wall: answers, prompt, no composer, nothing to rearrange', async () => {
    const services = await mountWall(
      { api: { ...presetApi([]), getHistoryEntry: async () => structuredClone(past) } },
      viewAskHref('ask-past'),
    );
    await waitFor(() => expect(names()).toEqual(['Claude', 'Grok']));
    expect(services.apiCalls).toContainEqual({ method: 'getHistoryEntry', args: ['ask-past'] });
    expect(statuses()).toEqual(['Done', 'Failed']);
    expect(cells()[0]?.querySelector('.wall-markdown strong')?.textContent).toBe('pattern');
    expect(document.querySelector('.wall-asked-text')?.textContent).toBe('What is a monad?');
    expect(document.querySelector<HTMLDetailsElement>('.wall-asked')?.open).toBe(true);
    expect(document.querySelector('.wall-view-banner')?.textContent).toContain('read-only');

    expect(screen.queryByLabelText('Prompt')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add cell' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Presets' })).toBeNull();
    expect(screen.queryByLabelText('Provider')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Remove|Duplicate|Move)/ })).toBeNull();
    expect(services.asks.current()).toBeUndefined();
  });

  test('leaves the arrangement of the wall untouched', async () => {
    await mountWall(
      { api: { ...presetApi([]), getHistoryEntry: async () => structuredClone(past) } },
      viewAskHref('ask-past'),
    );
    await waitFor(() => expect(names()).toEqual(['Claude', 'Grok']));
    fireEvent.click(screen.getByRole('button', { name: 'Maximise Grok' }));
    expect(names(visibleCells())).toEqual(['Grok']);
    fireEvent.click(screen.getByRole('link', { name: 'Back to the wall' }));
    await waitFor(() => expect(names()).toEqual(['Claude', 'Codex', 'Grok']));
    expect(names(visibleCells())).toEqual(['Claude', 'Codex', 'Grok']);
    expect(screen.getByLabelText('Prompt')).toBeDefined();
  });

  test('ask again loads its cells and prompt into the wall, ready to send', async () => {
    const services = await mountWall(
      { api: { ...presetApi([]), getHistoryEntry: async () => structuredClone(past) } },
      viewAskHref('ask-past'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ask again' }));
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toBeDefined());
    expect(prompt().value).toBe('What is a monad?');
    expect(names()).toEqual(['Claude', 'Grok']);
    expect(statuses()).toEqual(['No answer yet', 'No answer yet']);
    expect(services.toasts).toEqual([
      { kind: 'info', message: 'Cells and prompt loaded. Press Send to ask again.' },
    ]);
    expect(services.asks.submitted).toEqual([]);

    fireEvent.click(sendButton());
    await settle();
    expect(services.asks.submitted).toEqual([
      {
        prompt: 'What is a monad?',
        targets: [
          { slotId: 'h-1', providerId: 'claude', model: 'opus' },
          { slotId: 'h-2', providerId: 'grok' },
        ],
      },
    ]);
  });

  test('the re-ask address does the same and is consumed', async () => {
    const services = createFakeServices({
      api: { ...presetApi([]), getHistoryEntry: async () => structuredClone(past) },
    });
    const { history } = mountPages(reaskHref('ask-past'), services);
    await waitFor(() => expect(history.get()).toBe(ROUTES.wall));
    expect(prompt().value).toBe('What is a monad?');
    expect(names()).toEqual(['Claude', 'Grok']);
    expect(services.asks.submitted).toEqual([]);
  });

  test('a past ask that cannot be loaded says so and offers the way back', async () => {
    const failure = new ApiError('not_found', 404, 'No such ask');
    const services = await mountWall(
      { api: { ...presetApi([]), getHistoryEntry: async () => Promise.reject(failure) } },
      viewAskHref('gone'),
    );
    await waitFor(() =>
      expect(document.querySelector('.wall-view-banner')?.textContent).toContain(
        'This ask could not be loaded.',
      ),
    );
    expect(services.errors).toEqual([failure]);
    expect(cells()).toEqual([]);
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('href')).toBe(ROUTES.history);
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
  });

  test('an ask that is still running is followed live and can be cancelled', async () => {
    const running = askSnapshot(
      [slotSnapshot({ slotId: 'h-1', status: 'running', streaming: 'token', text: 'so far' })],
      { status: 'running', seq: 3 },
    );
    const services = await mountWall(
      { api: { ...presetApi([]), getHistoryEntry: async () => structuredClone(running) } },
      viewAskHref('ask-past'),
    );
    await waitFor(() => expect(statuses()).toEqual(['Answering']));
    const stream = services.asks.current();
    expect(stream?.askId).toBe('ask-past');
    stream?.apply({ type: 'snapshot', seq: 3, snapshot: structuredClone(running) });
    stream?.apply({
      type: 'delta',
      seq: 4,
      slotId: 'h-1',
      providerId: 'claude',
      text: ' and more',
    });
    stream?.apply({ type: 'done', seq: 5, slotId: 'h-1', providerId: 'claude', elapsedMs: 9 });
    expect(statuses()).toEqual(['Done']);
    await waitFor(() =>
      expect(cells()[0]?.querySelector('.wall-markdown')?.textContent.trim()).toBe(
        'so far and more',
      ),
    );
  });
});

describe('language', () => {
  test('the wall follows the language of the app', async () => {
    const services = await mountWall();
    services.i18n.setLanguage('zh-TW');
    expect(screen.getByRole('button', { name: '新增格子' })).toBeDefined();
    expect(statuses()).toEqual(['尚無答案', '尚無答案', '尚無答案']);
    expect(screen.getByRole('button', { name: '送出給 3 格' })).toBeDefined();
  });
});
