import { describe, expect, test } from 'vitest';
import {
  API_PATHS,
  AskSnapshotSchema,
  HISTORY_PAGE_SIZE,
  HistoryPageSchema,
} from '../protocol/index.ts';
import type { AskSnapshot } from '../protocol/index.ts';
import { createTestApp } from '../testing/index.ts';
import type { TestApp } from '../testing/index.ts';

const T0 = Date.UTC(2026, 0, 1);

function entry(askId: string, minute: number, overrides: Partial<AskSnapshot> = {}): AskSnapshot {
  return {
    askId,
    conversationId: `conversation-${askId}`,
    prompt: `prompt of ${askId}`,
    createdAt: T0 + minute * 60_000,
    status: 'done',
    seq: 3,
    slots: [
      {
        slotId: 'a',
        providerId: 'claude',
        kind: 'claude',
        model: 'sonnet',
        status: 'done',
        text: `answer body of ${askId}`,
        reasoning: '',
        notices: [],
        truncated: false,
      },
    ],
    ...overrides,
  };
}

async function seeded(count: number): Promise<TestApp> {
  const t = createTestApp();
  for (let n = 1; n <= count; n++) await t.deps.storage.turns.create(entry(`ask-${n}`, n));
  return t;
}

const errorCode = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('GET /api/history', () => {
  test('lists the newest asks first, without answer bodies', async () => {
    const t = await seeded(3);

    const response = await t.request('GET', API_PATHS.history);

    expect(response.status).toBe(200);
    const text = await response.text();
    const page = HistoryPageSchema.parse(JSON.parse(text));
    expect(page.items.map((item) => item.askId)).toEqual(['ask-3', 'ask-2', 'ask-1']);
    expect(page.items[0]).toEqual({
      askId: 'ask-3',
      conversationId: 'conversation-ask-3',
      promptPreview: 'prompt of ask-3',
      createdAt: T0 + 3 * 60_000,
      slots: [
        { slotId: 'a', providerId: 'claude', kind: 'claude', model: 'sonnet', status: 'done' },
      ],
    });
    expect(page.nextCursor).toBeNull();
    expect(text).not.toContain('answer body');
  });

  test('pages with limit and cursor until the cursor is null', async () => {
    const t = await seeded(5);
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const params = new URLSearchParams({ limit: '2', ...(cursor === null ? {} : { cursor }) });
      const response = await t.request('GET', `${API_PATHS.history}?${params.toString()}`);
      const page = HistoryPageSchema.parse(await response.json());
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.askId));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(['ask-5', 'ask-4', 'ask-3', 'ask-2', 'ask-1']);
  });

  test('filters with q, and an empty q means no filter', async () => {
    const t = await seeded(2);
    await t.deps.storage.turns.create(entry('special', 9, { prompt: 'Find the Needle' }));

    const filtered = await t.request('GET', `${API_PATHS.history}?q=needle`);
    const unfiltered = await t.request('GET', `${API_PATHS.history}?q=&cursor=&limit=`);

    expect(HistoryPageSchema.parse(await filtered.json()).items.map((i) => i.askId)).toEqual([
      'special',
    ]);
    expect(HistoryPageSchema.parse(await unfiltered.json()).items).toHaveLength(3);
  });

  test('uses the default page size', async () => {
    const t = await seeded(HISTORY_PAGE_SIZE.default + 2);

    const page = HistoryPageSchema.parse(await (await t.request('GET', API_PATHS.history)).json());

    expect(page.items).toHaveLength(HISTORY_PAGE_SIZE.default);
    expect(page.nextCursor).not.toBeNull();
  });

  test.each([
    ['limit=0'],
    [`limit=${HISTORY_PAGE_SIZE.max + 1}`],
    ['limit=abc'],
    ['limit=1.5'],
    [`q=${'x'.repeat(201)}`],
    [`cursor=${'c'.repeat(201)}`],
  ])('rejects ?%s as a bad request', async (queryString) => {
    const t = await seeded(1);

    const response = await t.request('GET', `${API_PATHS.history}?${queryString}`);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('bad_request');
  });

  test('needs authentication', async () => {
    const t = await seeded(1);

    expect((await t.app.request(API_PATHS.history)).status).toBe(401);
  });
});

describe('GET /api/history/:askId', () => {
  test('returns the full entry with its answers', async () => {
    const t = await seeded(2);

    const response = await t.request('GET', API_PATHS.historyEntry('ask-2'));

    expect(response.status).toBe(200);
    expect(AskSnapshotSchema.parse(await response.json())).toEqual(entry('ask-2', 2));
  });

  test('is 404 for an unknown ask', async () => {
    const t = await seeded(1);

    const response = await t.request('GET', API_PATHS.historyEntry('nope'));

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  test('needs authentication', async () => {
    const t = await seeded(1);

    expect((await t.app.request(API_PATHS.historyEntry('ask-1'))).status).toBe(401);
  });
});

describe('DELETE /api/history/:askId', () => {
  test('deletes the entry', async () => {
    const t = await seeded(2);

    const response = await t.request('DELETE', API_PATHS.historyEntry('ask-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await t.request('GET', API_PATHS.historyEntry('ask-1'))).status).toBe(404);
    const page = HistoryPageSchema.parse(await (await t.request('GET', API_PATHS.history)).json());
    expect(page.items.map((item) => item.askId)).toEqual(['ask-2']);
  });

  test('is 404 for an unknown ask, also the second time', async () => {
    const t = await seeded(1);
    await t.request('DELETE', API_PATHS.historyEntry('ask-1'));

    const again = await t.request('DELETE', API_PATHS.historyEntry('ask-1'));

    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('not_found');
  });

  test('refuses an ask that is still running and keeps it', async () => {
    const t = createTestApp();
    await t.deps.storage.turns.create(entry('live', 1, { status: 'running' }));

    const response = await t.request('DELETE', API_PATHS.historyEntry('live'));

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('conflict');
    expect((await t.request('GET', API_PATHS.historyEntry('live'))).status).toBe(200);
  });

  test('also drops the ask from the ask routes', async () => {
    const t = createTestApp();
    const submitted = await t.request('POST', API_PATHS.ask, {
      prompt: 'hello',
      targets: [{ slotId: 'a', providerId: 'claude' }],
    });
    const { askId } = (await submitted.json()) as { askId: string };
    t.asks.emit(askId, { type: 'ask_done' });
    await t.deps.storage.turns.create(entry(askId, 1));
    expect((await t.request('GET', API_PATHS.askSnapshot(askId))).status).toBe(200);

    await t.request('DELETE', API_PATHS.historyEntry(askId));

    expect((await t.request('GET', API_PATHS.askSnapshot(askId))).status).toBe(404);
  });

  test('a refused delete leaves the ask readable through the ask routes', async () => {
    const t = createTestApp();
    const submitted = await t.request('POST', API_PATHS.ask, {
      prompt: 'hello',
      targets: [{ slotId: 'a', providerId: 'claude' }],
    });
    const { askId } = (await submitted.json()) as { askId: string };
    await t.deps.storage.turns.create(entry(askId, 1, { status: 'running' }));

    await t.request('DELETE', API_PATHS.historyEntry(askId));

    expect((await t.request('GET', API_PATHS.askSnapshot(askId))).status).toBe(200);
  });

  test('needs authentication', async () => {
    const t = await seeded(1);

    const response = await t.app.request(API_PATHS.historyEntry('ask-1'), { method: 'DELETE' });

    expect(response.status).toBe(401);
    expect((await t.request('GET', API_PATHS.historyEntry('ask-1'))).status).toBe(200);
  });
});
