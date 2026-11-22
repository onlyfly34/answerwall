import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createDefaultSettings, PROVIDER_ERROR_CODES } from '@answerwall/core/protocol';
import type { AskTarget, ProviderStatus, SlotSnapshot } from '@answerwall/core/protocol';
import { ROUTES } from '../../contracts/routes.ts';
import { createFakeServices, readyProviderStatus } from '../../contracts/testing.ts';
import type { FakeServices } from '../../contracts/testing.ts';
import { COPIED_FEEDBACK_MS } from '../markdown/Markdown.tsx';
import { RENDER_INTERVAL_MS } from '../markdown/scheduler.ts';
import { en } from '../messages/en.ts';
import { renderWithServices, slotSnapshot } from '../test-support.tsx';
import { Cell } from './Cell.tsx';
import type { CellProps } from './Cell.tsx';

const START = Date.UTC(2026, 0, 15, 12, 0);

type HandlerName =
  'onChange' | 'onRemove' | 'onDuplicate' | 'onToggleMaximise' | 'onCancel' | 'onMove';

interface Mounted {
  services: FakeServices;
  cell: HTMLElement;
  body: HTMLElement;
  handlers: Record<HandlerName, Mock<() => void>>;
  /** Changes the slot's snapshot as the stream store would: field by field. */
  patch: (change: Partial<SlotSnapshot>) => void;
  setNow: (now: number) => void;
}

function mount(
  snapshot?: SlotSnapshot,
  props: Partial<CellProps> = {},
  services: FakeServices = createFakeServices(),
): Mounted {
  const [state, setState] = createStore<{ snapshot: SlotSnapshot | undefined }>({ snapshot });
  const [now, setNow] = createSignal(Date.now());
  const slot: AskTarget = { slotId: 's-1', providerId: 'claude' };
  const handlers: Mounted['handlers'] = {
    onChange: vi.fn<() => void>(),
    onRemove: vi.fn<() => void>(),
    onDuplicate: vi.fn<() => void>(),
    onToggleMaximise: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
    onMove: vi.fn<() => void>(),
  };
  renderWithServices(
    () => (
      <Cell
        slot={slot}
        snapshot={state.snapshot}
        queuePosition={undefined}
        index={1}
        count={3}
        readOnly={false}
        hidden={false}
        maximised={false}
        single={false}
        dragging={false}
        now={now}
        onDragStart={() => undefined}
        {...handlers}
        {...props}
      />
    ),
    services,
  );
  const cell = document.querySelector<HTMLElement>('.wall-cell');
  if (!cell) throw new Error('the cell was not rendered');
  const body = cell.querySelector<HTMLElement>('.wall-cell-body');
  if (!body) throw new Error('the cell has no body');
  return {
    services,
    cell,
    body,
    handlers,
    patch: (change) =>
      setState('snapshot', (previous) => ({ ...slotSnapshot(), ...previous, ...change })),
    setNow,
  };
}

const status = (): string | null | undefined =>
  document.querySelector('.wall-cell-status')?.textContent;

function providersWith(change: (claude: ProviderStatus) => ProviderStatus): ProviderStatus[] {
  return createDefaultSettings()
    .providers.map(readyProviderStatus)
    .map((provider) => (provider.instance.id === 'claude' ? change(provider) : provider));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cell header', () => {
  test('shows the provider label, the effective model and the pickers', () => {
    const services = createFakeServices({
      providers: providersWith((claude) => ({
        ...claude,
        instance: { ...claude.instance, defaultModel: 'sonnet' },
      })),
    });
    const { cell } = mount(undefined, {}, services);
    expect(within(cell).getByRole('heading', { name: 'Claude' })).toBeDefined();
    expect(cell.querySelector('.wall-cell-model')?.textContent).toBe('sonnet');
    expect(within(cell).getByLabelText('Provider')).toBeDefined();
    expect(within(cell).getByLabelText('Model')).toBeDefined();
    expect(cell.getAttribute('aria-label')).toBe('Claude');
  });

  test('duplicate, maximise and remove call back', () => {
    const { handlers } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximise Claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude' }));
    expect(handlers.onDuplicate).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMaximise).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
  });

  test('a maximised cell offers to restore', () => {
    mount(undefined, { maximised: true });
    const button = screen.getByRole('button', { name: 'Restore Claude' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  test.each([
    ['ArrowRight', 2],
    ['ArrowDown', 2],
    ['ArrowLeft', 0],
    ['ArrowUp', 0],
    ['Home', 0],
    ['End', 2],
  ])('%s on the handle moves the cell to position %i', (key, target) => {
    const { handlers } = mount();
    const handle = screen.getByRole('button', { name: 'Move Claude, position 2 of 3' });
    expect(fireEvent.keyDown(handle, { key })).toBe(false);
    expect(handlers.onMove).toHaveBeenCalledWith(target);
  });

  test('the handle does not move a cell past either end and ignores other keys', () => {
    const first = mount(undefined, { index: 0 });
    const handle = screen.getByRole('button', { name: /^Move Claude/ });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(fireEvent.keyDown(handle, { key: 'a' })).toBe(true);
    expect(first.handlers.onMove).not.toHaveBeenCalled();
  });

  test('a read-only cell cannot be reconfigured, moved, duplicated or removed', () => {
    const { cell } = mount(
      slotSnapshot({ status: 'done', text: 'Answer', model: 'opus', effort: 'high' }),
      { readOnly: true },
    );
    expect(within(cell).queryByLabelText('Provider')).toBeNull();
    expect(within(cell).queryByRole('button', { name: /^Move/ })).toBeNull();
    expect(within(cell).queryByRole('button', { name: /^Duplicate/ })).toBeNull();
    expect(within(cell).queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(within(cell).getByRole('button', { name: 'Maximise Claude' })).toBeDefined();
    expect(cell.querySelector('.wall-cell-model')?.textContent).toBe('opus · high');
  });

  test.each([
    [
      'disabled',
      (claude: ProviderStatus): ProviderStatus => ({
        ...claude,
        instance: { ...claude.instance, enabled: false },
      }),
      en['wall.issue.notice.disabled'],
    ],
    [
      'not installed',
      (claude: ProviderStatus): ProviderStatus => ({
        ...claude,
        detection: { installed: false, loggedIn: 'unknown', streaming: 'unknown' },
      }),
      en['wall.issue.notice.not_installed'],
    ],
    [
      'not logged in',
      (claude: ProviderStatus): ProviderStatus => ({
        ...claude,
        detection: {
          installed: true,
          loggedIn: 'no',
          streaming: 'token',
          hint: 'Run the login command in a terminal.',
        },
      }),
      en['wall.issue.notice.not_logged_in'],
    ],
  ])(
    'a provider that is %s shows the reason and a link to the Providers page',
    (_n, change, text) => {
      const { cell } = mount(
        undefined,
        {},
        createFakeServices({ providers: providersWith(change) }),
      );
      const issue = cell.querySelector('.wall-cell-issue');
      expect(issue?.textContent).toContain(text);
      const link = within(cell).getByRole('link', { name: 'Open Providers' });
      expect(link.getAttribute('href')).toBe(ROUTES.providers);
    },
  );

  test('a provider that is no longer configured is named by its id with the reason', () => {
    const services = createFakeServices({ providers: [] });
    const { cell } = mount(undefined, {}, services);
    expect(within(cell).getByRole('heading', { name: 'claude' })).toBeDefined();
    expect(cell.querySelector('.wall-cell-issue')?.textContent).toContain(
      en['wall.issue.notice.missing'],
    );
    expect(
      within(cell).getByRole('option', { name: 'claude (not configured any more)' }),
    ).toBeDefined();
  });

  test('a detection hint is shown next to the reason', () => {
    const services = createFakeServices({
      providers: providersWith((claude) => ({
        ...claude,
        detection: {
          installed: true,
          loggedIn: 'no',
          streaming: 'token',
          hint: 'Run claude login.',
        },
      })),
    });
    const { cell } = mount(undefined, {}, services);
    expect(cell.querySelector('.wall-cell-issue')?.textContent).toContain('Run claude login.');
  });
});

describe('cell states', () => {
  test('idle: no answer yet, nothing to cancel or copy', () => {
    const { cell } = mount();
    expect(status()).toBe('No answer yet');
    expect(cell.dataset.phase).toBe('idle');
    expect(screen.queryByRole('button', { name: 'Cancel Claude' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy the answer/ })).toBeNull();
    expect(screen.queryByTestId('elapsed')).toBeNull();
  });

  test('queued, with the position when it is known', () => {
    const plain = mount(slotSnapshot());
    expect(status()).toBe('Queued');
    expect(plain.cell.dataset.phase).toBe('queued');
    expect(screen.getByRole('button', { name: 'Cancel Claude' })).toBeDefined();
    cleanup();
    mount(slotSnapshot(), { queuePosition: 3 });
    expect(status()).toBe('Queued, position 3');
  });

  test('running without output: waiting, with the elapsed time ticking', () => {
    const { cell, patch, setNow } = mount(slotSnapshot());
    patch({ status: 'running', streaming: 'token', startedAt: START });
    expect(status()).toBe('Waiting for the first words');
    expect(cell.dataset.phase).toBe('waiting');
    expect(screen.getByTestId('elapsed').textContent).toBe('0 s');
    setNow(START + 7_400);
    expect(screen.getByTestId('elapsed').textContent).toBe('7 s');
    setNow(START + 65_000);
    expect(screen.getByTestId('elapsed').textContent).toBe('1:05');
  });

  test('a slot found already running counts from when the server started it', () => {
    mount(slotSnapshot({ status: 'running', streaming: 'token', startedAt: START - 30_000 }));
    expect(screen.getByTestId('elapsed').textContent).toBe('30 s');
  });

  test('a server clock ahead of this device never gives a negative time', () => {
    mount(slotSnapshot({ status: 'running', streaming: 'token', startedAt: START + 60_000 }));
    expect(screen.getByTestId('elapsed').textContent).toBe('0 s');
  });

  test('running with text: answering, rendered as Markdown', () => {
    const { cell, patch } = mount(slotSnapshot({ status: 'running', streaming: 'token' }));
    patch({ text: 'Hello **world**' });
    vi.advanceTimersByTime(RENDER_INTERVAL_MS);
    expect(status()).toBe('Answering');
    expect(cell.dataset.phase).toBe('streaming');
    expect(cell.querySelector('.wall-markdown strong')?.textContent).toBe('world');
  });

  test('a provider that streams in blocks says so, before and after its first block', () => {
    const { patch } = mount(slotSnapshot({ status: 'running', streaming: 'block' }));
    expect(status()).toBe('Generating — this provider does not stream token by token');
    patch({ text: 'A whole message.' });
    expect(status()).toBe('Generating — this provider does not stream token by token');
    patch({ status: 'done', elapsedMs: 900 });
    expect(status()).toBe('Done');
  });

  test('done: final time, token usage, the model that answered, no cancel', () => {
    const { cell } = mount(
      slotSnapshot({
        status: 'done',
        text: 'Answer',
        model: 'opus',
        effort: 'high',
        elapsedMs: 7_432,
        usage: { inputTokens: 12, outputTokens: 345, reasoningTokens: 6 },
      }),
    );
    expect(status()).toBe('Done');
    expect(cell.dataset.phase).toBe('done');
    expect(screen.getByTestId('elapsed').textContent).toBe('7.4 s');
    expect(screen.getByTestId('usage').textContent).toBe('12 in · 345 out · 6 reasoning');
    expect(cell.querySelector('.wall-cell-statusbar')?.textContent).toContain('opus · high');
    expect(screen.queryByRole('button', { name: 'Cancel Claude' })).toBeNull();
  });

  test('usage shows only the counts the provider reported', () => {
    mount(slotSnapshot({ status: 'done', usage: { outputTokens: 5 } }));
    expect(screen.getByTestId('usage').textContent).toBe('5 out');
    cleanup();
    mount(slotSnapshot({ status: 'done', usage: {} }));
    expect(screen.queryByTestId('usage')).toBeNull();
  });

  test.each(PROVIDER_ERROR_CODES)(
    'error %s: a human message plus what the provider said',
    (code) => {
      const { cell } = mount(
        slotSnapshot({
          status: 'error',
          text: 'partial answer',
          elapsedMs: 1_200,
          error: { code, message: `detail for ${code}` },
        }),
      );
      expect(status()).toBe('Failed');
      expect(cell.dataset.phase).toBe('error');
      const alert = screen.getByRole('alert');
      expect(alert.querySelector('strong')?.textContent).toBe(en[`wall.error.${code}`]);
      expect(alert.textContent).toContain(`detail for ${code}`);
      // What arrived before the failure stays readable.
      expect(cell.querySelector('.wall-markdown')?.textContent).toContain('partial answer');
      expect(screen.queryByRole('button', { name: 'Cancel Claude' })).toBeNull();
    },
  );

  test('an error message from a provider is text, never markup', () => {
    mount(
      slotSnapshot({
        status: 'error',
        error: {
          code: 'unknown',
          message: '<img src=http://tracker.example/e.png onerror=alert(1)>',
        },
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('img')).toBeNull();
    expect(alert.textContent).toContain('<img src=http://tracker.example/e.png');
  });

  test('cancelled and timed out keep the partial answer', () => {
    const cancelled = mount(
      slotSnapshot({ status: 'cancelled', text: 'so far', elapsedMs: 2_000 }),
    );
    expect(status()).toBe('Cancelled');
    expect(cancelled.cell.dataset.phase).toBe('cancelled');
    expect(cancelled.cell.querySelector('.wall-markdown')?.textContent).toContain('so far');
    cleanup();
    const timedOut = mount(slotSnapshot({ status: 'timeout', text: 'so far', elapsedMs: 300_000 }));
    expect(status()).toBe('Timed out');
    expect(timedOut.cell.dataset.phase).toBe('timeout');
    expect(screen.getByTestId('elapsed').textContent).toBe('5:00');
  });

  test('a truncated answer is flagged and provider notices are listed as text', () => {
    const { cell } = mount(
      slotSnapshot({
        status: 'done',
        text: 'long',
        truncated: true,
        notices: [
          { code: 'provider', message: 'A tool call was denied <b>here</b>.' },
          { code: 'output_truncated', message: 'internal wording' },
        ],
      }),
    );
    expect(cell.querySelector('.wall-cell-flag')?.textContent).toBe(en['wall.cell.truncated']);
    const notices = Array.from(cell.querySelectorAll('.wall-cell-notice'), (n) => n.textContent);
    expect(notices).toEqual(['A tool call was denied <b>here</b>.']);
    expect(cell.querySelector('.wall-cell-notice b')).toBeNull();
  });

  test('the cancel button cancels this cell while it is active', () => {
    const { handlers, patch } = mount(slotSnapshot({ status: 'running', streaming: 'token' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Claude' }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    patch({ status: 'cancelled', elapsedMs: 10 });
    expect(screen.queryByRole('button', { name: 'Cancel Claude' })).toBeNull();
  });
});

describe('cell content', () => {
  test('reasoning is collapsed until opened and is shown as plain text', () => {
    const { cell } = mount(
      slotSnapshot({ status: 'running', reasoning: 'thinking <script>alert(1)</script>' }),
    );
    const details = cell.querySelector('details');
    if (!details) throw new Error('the cell has no reasoning section');
    expect(details.open).toBe(false);
    expect(within(details).getByText('Reasoning')).toBeDefined();
    expect(details.querySelector('pre')).toBeNull();

    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(details.querySelector('pre')?.textContent).toBe('thinking <script>alert(1)</script>');
    expect(details.querySelector('script')).toBeNull();

    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(details.querySelector('pre')).toBeNull();
  });

  test('a cell without reasoning has no reasoning section', () => {
    const { cell } = mount(slotSnapshot({ status: 'done', text: 'Answer' }));
    expect(cell.querySelector('details')).toBeNull();
  });

  test('hostile Markdown in an answer creates nothing that loads or runs', () => {
    const text = [
      '<img src=http://tracker.example/a.png>',
      '<script>fetch("http://tracker.example/")</script>',
      '[click](javascript:alert(1))',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)><image href="http://tracker.example/i.png"/></svg>',
      '[page](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '![remote](http://tracker.example/b.png)',
      '[fine](https://example.com/)',
    ].join('\n\n');
    const { cell } = mount(slotSnapshot({ status: 'done', text }));
    const answer = cell.querySelector<HTMLElement>('.wall-markdown');
    if (!answer) throw new Error('the cell has no answer');
    expect(
      answer.querySelector('img, script, svg, image, iframe, object, embed, style, link'),
    ).toBeNull();
    for (const element of Array.from(answer.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(['src', 'srcset', 'style']).not.toContain(attribute.name);
      }
    }
    // A link whose target was refused is left without one.
    const links = Array.from(answer.querySelectorAll<HTMLAnchorElement>('a[href]'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'http://tracker.example/b.png',
      'https://example.com/',
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }
  });

  test('copies the whole answer as the provider wrote it and confirms', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText }, userAgent: 'test' });
    mount(slotSnapshot({ status: 'done', text: '# Title\n\n**bold**' }));
    const button = screen.getByRole('button', { name: 'Copy the answer of Claude' });
    expect(button.textContent).toBe('Copy answer');
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('# Title\n\n**bold**');
    expect(button.textContent).toBe('Copied');
    vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
    expect(button.textContent).toBe('Copy answer');
  });

  describe('auto-scroll', () => {
    function withHeights(body: HTMLElement, heights: { scroll: number; client: number }): void {
      Object.defineProperty(body, 'scrollHeight', {
        configurable: true,
        get: () => heights.scroll,
      });
      Object.defineProperty(body, 'clientHeight', {
        configurable: true,
        get: () => heights.client,
      });
    }

    test('follows the answer until the reader scrolls up, and again once back at the bottom', () => {
      const { body, patch } = mount(slotSnapshot({ status: 'running', streaming: 'token' }));
      const heights = { scroll: 1000, client: 200 };
      withHeights(body, heights);

      patch({ text: 'one' });
      vi.advanceTimersByTime(RENDER_INTERVAL_MS);
      expect(body.scrollTop).toBe(1000);

      // The reader scrolls up.
      body.scrollTop = 300;
      fireEvent.scroll(body);
      heights.scroll = 1500;
      patch({ text: 'one two' });
      vi.advanceTimersByTime(RENDER_INTERVAL_MS);
      expect(body.scrollTop).toBe(300);

      // Back within reach of the bottom: following resumes.
      body.scrollTop = 1500 - 200 - 10;
      fireEvent.scroll(body);
      heights.scroll = 2000;
      patch({ text: 'one two three' });
      vi.advanceTimersByTime(RENDER_INTERVAL_MS);
      expect(body.scrollTop).toBe(2000);
    });

    test('a new ask starts following again', () => {
      const { body, patch } = mount(slotSnapshot({ status: 'done', text: 'old' }));
      const heights = { scroll: 1000, client: 200 };
      withHeights(body, heights);
      body.scrollTop = 0;
      fireEvent.scroll(body);

      patch({ status: 'queued', text: '' });
      patch({ status: 'running', text: 'new' });
      vi.advanceTimersByTime(RENDER_INTERVAL_MS);
      expect(body.scrollTop).toBe(1000);
    });
  });

  test('a phone cell is a tab panel labelled by its tab and has no grid controls', () => {
    const { cell } = mount(slotSnapshot(), { single: true });
    expect(cell.getAttribute('role')).toBe('tabpanel');
    expect(cell.getAttribute('aria-labelledby')).toBe('wall-tab-s-1');
    expect(within(cell).queryByRole('button', { name: /^Move/ })).toBeNull();
    expect(within(cell).queryByRole('button', { name: /^Maximise/ })).toBeNull();
    expect(within(cell).getByRole('button', { name: 'Duplicate Claude' })).toBeDefined();
  });

  test('a hidden cell is not displayed', () => {
    const { cell } = mount(slotSnapshot(), { hidden: true });
    expect(cell.hidden).toBe(true);
  });
});
