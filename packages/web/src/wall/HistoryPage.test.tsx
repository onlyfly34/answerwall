import { cleanup, fireEvent, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  HistoryItem,
  HistoryPage as HistoryPageData,
  HistoryQuery,
} from '@answerwall/core/protocol';
import { ROUTES } from '../contracts/routes.ts';
import { ApiError } from '../contracts/services.ts';
import type { ApiClient } from '../contracts/services.ts';
import { createFakeServices } from '../contracts/testing.ts';
import type { FakeServices } from '../contracts/testing.ts';
import { SEARCH_DEBOUNCE_MS } from './HistoryPage.tsx';
import { reaskHref, viewAskHref } from './navigation.ts';
import {
  askSnapshot,
  mountPages,
  setViewportWidth,
  settle,
  slotSnapshot,
} from './test-support.tsx';

function item(index: number, prompt = `Question ${index}`): HistoryItem {
  return {
    askId: `ask-${index}`,
    conversationId: `conversation-${index}`,
    promptPreview: prompt,
    createdAt: Date.UTC(2026, 0, index, 9, 30),
    slots: [
      { slotId: 'a', providerId: 'claude', kind: 'claude', model: 'opus', status: 'done' },
      { slotId: 'b', providerId: 'gone', kind: 'openai-compat', status: 'error' },
    ],
  };
}

/** A history of `count` asks served two per page, filtered by `q` as the server does. */
function historyApi(all: HistoryItem[]): Partial<ApiClient> {
  return {
    listPresets: async () => [],
    listHistory: async (query: Partial<HistoryQuery> = {}): Promise<HistoryPageData> => {
      const matching = all.filter((entry) =>
        entry.promptPreview.toLowerCase().includes((query.q ?? '').toLowerCase()),
      );
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const end = start + 2;
      return {
        items: matching.slice(start, end).map((entry) => structuredClone(entry)),
        nextCursor: end < matching.length ? String(end) : null,
      };
    },
    deleteHistoryEntry: async (askId: string) => {
      all.splice(
        all.findIndex((entry) => entry.askId === askId),
        1,
      );
    },
  };
}

async function mountHistory(api: Partial<ApiClient>): Promise<FakeServices> {
  const services = createFakeServices({ api });
  mountPages(ROUTES.history, services);
  await screen.findByRole('heading', { name: 'History' });
  await settle();
  return services;
}

const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.wall-history-item'));
const prompts = (): (string | null | undefined)[] =>
  rows().map((row) => row.querySelector('.wall-history-prompt')?.textContent);
const state = (): string | null | undefined =>
  document.querySelector('.wall-history-state')?.textContent;
const searchBox = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Search prompts');
const listCalls = (services: FakeServices): unknown[] =>
  services.apiCalls.filter((call) => call.method === 'listHistory').map((call) => call.args[0]);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  setViewportWidth(1280);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('history', () => {
  test('lists past asks newest first with their cells and the state of each', async () => {
    await mountHistory(historyApi([item(3), item(2)]));
    expect(prompts()).toEqual(['Question 3', 'Question 2']);
    const first = rows()[0] as HTMLElement;
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-03T09:30:00.000Z');
    const slots = Array.from(first.querySelectorAll('.wall-history-slot'));
    // A provider that is gone is named by its id.
    expect(slots.map((slot) => slot.textContent)).toEqual(['Claude opus done', 'gone error']);
    expect(
      slots.map((slot) => slot.querySelector<HTMLElement>('.wall-dot')?.dataset.phase),
    ).toEqual(['done', 'error']);
    expect(state()).toBe('');
  });

  test('every row opens the ask read-only or loads it for asking again', async () => {
    await mountHistory(historyApi([item(1)]));
    const row = rows()[0] as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Question 1' }).getAttribute('href')).toBe(
      viewAskHref('ask-1'),
    );
    expect(within(row).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      '/?ask=ask-1',
    );
    expect(within(row).getByRole('link', { name: 'Ask again' }).getAttribute('href')).toBe(
      reaskHref('ask-1'),
    );
  });

  test('opening an entry shows it read-only on the wall', async () => {
    const api = historyApi([item(1)]);
    api.getHistoryEntry = async () =>
      askSnapshot([slotSnapshot({ status: 'done', text: 'The stored answer.' })], {
        askId: 'ask-1',
        prompt: 'Question 1',
      });
    await mountHistory(api);
    fireEvent.click(screen.getByRole('link', { name: 'Open' }));
    await waitFor(() =>
      expect(document.querySelector('.wall-markdown')?.textContent.trim()).toBe(
        'The stored answer.',
      ),
    );
    expect(document.querySelector('.wall-view-banner')?.textContent).toContain('read-only');
    expect(screen.queryByLabelText('Prompt')).toBeNull();
  });

  test('pages are loaded on demand and appended', async () => {
    const services = await mountHistory(historyApi([item(5), item(4), item(3), item(2), item(1)]));
    expect(prompts()).toEqual(['Question 5', 'Question 4']);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(prompts()).toEqual(['Question 5', 'Question 4', 'Question 3', 'Question 2']);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(prompts()).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(listCalls(services)).toEqual([{}, { cursor: '2' }, { cursor: '4' }]);
  });

  test('typing searches after a pause, once, and starts from the first page', async () => {
    const services = await mountHistory(
      historyApi([item(4, 'Monads again'), item(3, 'Functors'), item(2, 'monad laws'), item(1)]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(prompts()).toHaveLength(4);

    vi.useFakeTimers();
    fireEvent.input(searchBox(), { target: { value: 'mo' } });
    fireEvent.input(searchBox(), { target: { value: 'mona' } });
    fireEvent.input(searchBox(), { target: { value: ' monad ' } });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(listCalls(services)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(listCalls(services)).toEqual([{}, { cursor: '2' }, { q: 'monad' }]);
    expect(prompts()).toEqual(['Monads again', 'monad laws']);
  });

  test('submitting searches at once; the same search is not repeated', async () => {
    const services = await mountHistory(historyApi([item(2, 'Monads'), item(1, 'Functors')]));
    vi.useFakeTimers();
    fireEvent.input(searchBox(), { target: { value: 'functor' } });
    fireEvent.submit(screen.getByRole('search'));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompts()).toEqual(['Functors']);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    fireEvent.submit(screen.getByRole('search'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listCalls(services)).toEqual([{}, { q: 'functor' }]);

    fireEvent.input(searchBox(), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('search'));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompts()).toEqual(['Monads', 'Functors']);
    expect(listCalls(services)[2]).toEqual({});
  });

  test('an empty history and a search without matches say different things', async () => {
    await mountHistory(historyApi([]));
    expect(state()).toBe('Nothing has been asked yet.');
    cleanup();
    await mountHistory(historyApi([item(1)]));
    fireEvent.input(searchBox(), { target: { value: 'zzz' } });
    fireEvent.submit(screen.getByRole('search'));
    await settle();
    expect(state()).toBe('No prompt matches.');
    expect(rows()).toEqual([]);
  });

  test('a slow answer to an old search never replaces a newer one', async () => {
    const pending: ((page: HistoryPageData) => void)[] = [];
    const services = await mountHistory({
      listPresets: async () => [],
      listHistory: () => new Promise<HistoryPageData>((resolve) => pending.push(resolve)),
    });
    expect(state()).toBe('Loading…');
    fireEvent.input(searchBox(), { target: { value: 'new' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(listCalls(services)).toEqual([{}, { q: 'new' }]);

    pending[1]?.({ items: [item(2, 'new result')], nextCursor: null });
    await settle();
    pending[0]?.({ items: [item(1, 'old result')], nextCursor: 'x' });
    await settle();
    expect(prompts()).toEqual(['new result']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(state()).toBe('');
  });

  test('a failed load is reported and says so', async () => {
    const failure = new ApiError('internal', 500, 'Something went wrong');
    const services = await mountHistory({
      listPresets: async () => [],
      listHistory: async () => Promise.reject(failure),
    });
    expect(state()).toBe('The history could not be loaded.');
    expect(services.errors).toEqual([failure]);
  });

  test('deleting asks for confirmation, then removes the row', async () => {
    const all = [item(2), item(1)];
    const services = await mountHistory(historyApi(all));
    const row = rows()[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(within(row).getByText('Delete this ask and its answers?')).toBeDefined();
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(all).toHaveLength(2);
    expect(services.apiCalls.some((call) => call.method === 'deleteHistoryEntry')).toBe(false);

    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await settle();
    expect(services.apiCalls).toContainEqual({ method: 'deleteHistoryEntry', args: ['ask-2'] });
    expect(prompts()).toEqual(['Question 1']);
    expect(all.map((entry) => entry.askId)).toEqual(['ask-1']);
  });

  test('deleting the ask that is on the wall takes it off the wall', async () => {
    const services = createFakeServices({ api: historyApi([item(1)]) });
    await services.asks.submit({ prompt: 'hi', targets: [{ slotId: 'a', providerId: 'claude' }] });
    expect(services.asks.current()?.askId).toBe('ask-1');
    mountPages(ROUTES.history, services);
    await screen.findByText('Question 1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(services.asks.current()).toBeUndefined();
  });

  test('a failed delete is reported and keeps the row', async () => {
    const failure = new ApiError('not_found', 404, 'No such ask');
    const api = historyApi([item(1)]);
    api.deleteHistoryEntry = async () => Promise.reject(failure);
    const services = await mountHistory(api);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(services.errors).toEqual([failure]);
    expect(prompts()).toEqual(['Question 1']);
    expect(screen.getByRole('link', { name: 'Open' })).toBeDefined();
  });

  test('dates follow the language of the app', async () => {
    const services = await mountHistory(historyApi([item(1)]));
    const english = rows()[0]?.querySelector('time')?.textContent;
    services.i18n.setLanguage('zh-TW');
    expect(screen.getByRole('heading', { name: '歷史紀錄' })).toBeDefined();
    expect(rows()[0]?.querySelector('time')?.textContent).not.toBe(english);
  });
});
