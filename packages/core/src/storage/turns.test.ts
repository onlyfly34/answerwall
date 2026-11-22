import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Storage } from '../contracts/index.ts';
import {
  AskSnapshotSchema,
  HISTORY_PREVIEW_CHARS,
  HistoryPageSchema,
  HistoryQuerySchema,
  SERVER_RESTARTED_ERROR,
} from '../protocol/index.ts';
import type { AskSnapshot, HistoryQuery, SlotSnapshot } from '../protocol/index.ts';
import { createMemoryLogger } from '../testing/index.ts';
import { IN_MEMORY, openConnection } from './connection.ts';
import { createSqliteStorage } from './index.ts';

const T0 = Date.UTC(2026, 0, 1);
const UNLIMITED = { maxAsks: 1_000_000, maxBytes: Number.MAX_SAFE_INTEGER };

function slot(slotId: string, overrides: Partial<SlotSnapshot> = {}): SlotSnapshot {
  return {
    slotId,
    providerId: 'claude',
    kind: 'claude',
    status: 'done',
    text: '',
    reasoning: '',
    notices: [],
    truncated: false,
    ...overrides,
  };
}

/** A finished ask with one slot, created `minute` minutes after `T0`. */
function ask(askId: string, minute = 0, overrides: Partial<AskSnapshot> = {}): AskSnapshot {
  return {
    askId,
    conversationId: `conversation-of-${askId}`,
    prompt: `prompt of ${askId}`,
    createdAt: T0 + minute * 60_000,
    status: 'done',
    seq: 0,
    slots: [slot('a')],
    ...overrides,
  };
}

const query = (input: Partial<Record<keyof HistoryQuery, unknown>> = {}): HistoryQuery =>
  HistoryQuerySchema.parse(input);

let storage: Storage;

beforeEach(async () => {
  storage = await createSqliteStorage({ file: IN_MEMORY, logger: createMemoryLogger() });
});

afterEach(async () => {
  await storage.close();
});

const listedIds = async (input: Partial<Record<keyof HistoryQuery, unknown>> = {}) =>
  (await storage.turns.list(query(input))).items.map((item) => item.askId);

describe('create and get', () => {
  test('a snapshot with every optional field survives the round trip unchanged', async () => {
    const full = ask('full', 0, {
      status: 'running',
      seq: 17,
      prompt: 'Why is the sky blue? 為什麼天空是藍色的？ 🌤',
      slots: [
        slot('first', {
          providerId: 'local-llm',
          kind: 'openai-compat',
          model: 'some-model',
          effort: 'high',
          status: 'done',
          streaming: 'token',
          text: 'Rayleigh scattering.',
          reasoning: 'Think about wavelengths.',
          notices: [
            { code: 'provider', message: 'a tool call was denied' },
            { code: 'output_truncated', message: 'output limit reached' },
          ],
          truncated: true,
          usage: { inputTokens: 12, outputTokens: 34, reasoningTokens: 5 },
          startedAt: T0 + 5,
          elapsedMs: 1234,
        }),
        slot('second', {
          status: 'error',
          error: { code: 'quota', message: 'Usage limit reached' },
          elapsedMs: 0,
        }),
        slot('third', { status: 'queued' }),
      ],
    });

    await storage.turns.create(full);

    const stored = await storage.turns.get('full');
    expect(stored).toEqual(full);
    expect(AskSnapshotSchema.parse(stored)).toEqual(full);
  });

  test('absent optional fields stay absent rather than becoming null', async () => {
    await storage.turns.create(ask('plain'));

    const stored = await storage.turns.get('plain');

    expect(Object.keys(stored?.slots[0] ?? {}).sort()).toEqual(
      [
        'kind',
        'notices',
        'providerId',
        'reasoning',
        'slotId',
        'status',
        'text',
        'truncated',
      ].sort(),
    );
  });

  test('slots come back in the order of the request, whatever their ids', async () => {
    const slots = ['zeta', 'alpha', 'mid', '10', '9'].map((id) => slot(id));
    await storage.turns.create(ask('ordered', 0, { slots }));

    const stored = await storage.turns.get('ordered');

    expect(stored?.slots.map((s) => s.slotId)).toEqual(['zeta', 'alpha', 'mid', '10', '9']);
  });

  test('an unknown ask is null', async () => {
    expect(await storage.turns.get('nope')).toBeNull();
  });

  test('creating the same ask twice fails and leaves the first one intact', async () => {
    await storage.turns.create(ask('once', 0, { prompt: 'original' }));

    await expect(storage.turns.create(ask('once', 0, { prompt: 'again' }))).rejects.toThrow(
      /UNIQUE/,
    );

    expect((await storage.turns.get('once'))?.prompt).toBe('original');
  });

  test('a failed create leaves nothing behind, not even the conversation', async () => {
    const duplicateSlots = ask('broken', 0, { slots: [slot('same'), slot('same')] });

    await expect(storage.turns.create(duplicateSlots)).rejects.toThrow(/UNIQUE/);

    expect(await storage.turns.get('broken')).toBeNull();
    expect(await storage.turns.conversationExists('conversation-of-broken')).toBe(false);
  });
});

describe('conversations', () => {
  test('a conversation exists once it has a turn', async () => {
    expect(await storage.turns.conversationExists('talk')).toBe(false);

    await storage.turns.create(ask('one', 0, { conversationId: 'talk' }));

    expect(await storage.turns.conversationExists('talk')).toBe(true);
  });

  test('several turns can share a conversation, which goes with its last turn', async () => {
    await storage.turns.create(ask('one', 0, { conversationId: 'talk' }));
    await storage.turns.create(ask('two', 1, { conversationId: 'talk' }));

    expect(await storage.turns.delete('one')).toBe('deleted');
    expect(await storage.turns.conversationExists('talk')).toBe(true);

    expect(await storage.turns.delete('two')).toBe('deleted');
    expect(await storage.turns.conversationExists('talk')).toBe(false);
  });
});

describe('save', () => {
  test('writes the status, the seq and every mutable slot field', async () => {
    const running = ask('live', 0, {
      status: 'running',
      slots: [slot('a', { status: 'queued' }), slot('b', { status: 'queued' })],
    });
    await storage.turns.create(running);

    const finished: AskSnapshot = {
      ...running,
      status: 'done',
      seq: 9,
      slots: [
        slot('a', {
          status: 'done',
          streaming: 'block',
          text: 'answer',
          reasoning: 'thought',
          notices: [{ code: 'provider', message: 'note' }],
          truncated: true,
          usage: { outputTokens: 3 },
          startedAt: T0 + 1,
          elapsedMs: 50,
        }),
        slot('b', {
          status: 'error',
          error: { code: 'network', message: 'connection reset' },
          startedAt: T0 + 2,
          elapsedMs: 7,
        }),
      ],
    };
    await storage.turns.save(finished);

    expect(await storage.turns.get('live')).toEqual(finished);
  });

  test('never changes what was fixed at creation', async () => {
    const original = ask('fixed', 0, {
      prompt: 'original prompt',
      slots: [slot('a', { model: 'opus', effort: 'low' })],
    });
    await storage.turns.create(original);

    await storage.turns.save({
      ...original,
      prompt: 'tampered',
      conversationId: 'elsewhere',
      createdAt: 1,
      slots: [
        slot('a', { providerId: 'codex', kind: 'codex', model: 'other', effort: 'max', text: 'x' }),
      ],
    });

    expect(await storage.turns.get('fixed')).toEqual({
      ...original,
      slots: [slot('a', { model: 'opus', effort: 'low', text: 'x' })],
    });
  });

  test('with dirty slot ids only those slots are written', async () => {
    const running = ask('partial', 0, {
      status: 'running',
      slots: [slot('a', { status: 'running' }), slot('b', { status: 'running' })],
    });
    await storage.turns.create(running);

    await storage.turns.save(
      {
        ...running,
        seq: 4,
        slots: [
          slot('a', { status: 'running', text: 'written' }),
          slot('b', { status: 'running', text: 'not written' }),
        ],
      },
      ['a'],
    );

    const stored = await storage.turns.get('partial');
    expect(stored?.seq).toBe(4);
    expect(stored?.slots.map((s) => s.text)).toEqual(['written', '']);
  });

  test('an empty dirty list still writes the status and the seq', async () => {
    const running = ask('header', 0, { status: 'running', slots: [slot('a', { text: 'kept' })] });
    await storage.turns.create(running);

    await storage.turns.save({ ...running, status: 'done', seq: 2, slots: [slot('a')] }, []);

    const stored = await storage.turns.get('header');
    expect(stored).toMatchObject({ status: 'done', seq: 2 });
    expect(stored?.slots[0]?.text).toBe('kept');
  });

  test('clears a field the new snapshot no longer has', async () => {
    const failed = ask('retry', 0, {
      slots: [slot('a', { status: 'error', error: { code: 'unknown', message: 'x' } })],
    });
    await storage.turns.create(failed);

    await storage.turns.save({ ...failed, slots: [slot('a', { status: 'done', text: 'ok' })] });

    expect((await storage.turns.get('retry'))?.slots[0]).toEqual(slot('a', { text: 'ok' }));
  });

  test('saving an ask that is not stored does nothing', async () => {
    await storage.turns.save(ask('ghost', 0, { slots: [slot('a', { text: 'boo' })] }));

    expect(await storage.turns.get('ghost')).toBeNull();
    expect(await listedIds()).toEqual([]);
  });
});

describe('failInterrupted', () => {
  test('ends unfinished turns: queued and running slots fail, finished slots keep their outcome', async () => {
    await storage.turns.create(
      ask('interrupted', 0, {
        status: 'running',
        slots: [
          slot('queued', { status: 'queued' }),
          slot('running', { status: 'running', text: 'partial answer', startedAt: T0 }),
          slot('finished', { status: 'done', text: 'complete' }),
          slot('cancelled', { status: 'cancelled' }),
        ],
      }),
    );
    await storage.turns.create(ask('untouched', 1, { slots: [slot('a', { text: 'fine' })] }));

    expect(await storage.turns.failInterrupted(SERVER_RESTARTED_ERROR)).toBe(2);

    const stored = await storage.turns.get('interrupted');
    expect(stored?.status).toBe('done');
    expect(stored?.slots.map((s) => [s.slotId, s.status, s.error])).toEqual([
      ['queued', 'error', SERVER_RESTARTED_ERROR],
      ['running', 'error', SERVER_RESTARTED_ERROR],
      ['finished', 'done', undefined],
      ['cancelled', 'cancelled', undefined],
    ]);
    expect(stored?.slots[1]?.text).toBe('partial answer');
    expect(AskSnapshotSchema.safeParse(stored).success).toBe(true);
    expect(await storage.turns.get('untouched')).toEqual(
      ask('untouched', 1, { slots: [slot('a', { text: 'fine' })] }),
    );
  });

  test('a turn whose slots all finished before the flush of its status is still closed', async () => {
    await storage.turns.create(ask('almost', 0, { status: 'running' }));

    expect(await storage.turns.failInterrupted(SERVER_RESTARTED_ERROR)).toBe(0);

    expect((await storage.turns.get('almost'))?.status).toBe('done');
  });

  test('does nothing the second time', async () => {
    await storage.turns.create(
      ask('once', 0, { status: 'running', slots: [slot('a', { status: 'running' })] }),
    );
    await storage.turns.failInterrupted(SERVER_RESTARTED_ERROR);

    expect(await storage.turns.failInterrupted({ code: 'timeout', message: 'other' })).toBe(0);
    expect((await storage.turns.get('once'))?.slots[0]?.error).toEqual(SERVER_RESTARTED_ERROR);
  });
});

describe('list', () => {
  test('rows are newest first and carry no answer bodies', async () => {
    await storage.turns.create(
      ask('old', 0, {
        slots: [
          slot('a', { model: 'opus', text: 'secret answer', reasoning: 'secret thought' }),
          slot('b', { providerId: 'codex', kind: 'codex', status: 'error' }),
        ],
      }),
    );
    await storage.turns.create(ask('new', 1));

    const page = await storage.turns.list(query());

    expect(HistoryPageSchema.parse(page)).toEqual(page);
    expect(page).toEqual({
      items: [
        {
          askId: 'new',
          conversationId: 'conversation-of-new',
          promptPreview: 'prompt of new',
          createdAt: T0 + 60_000,
          slots: [{ slotId: 'a', providerId: 'claude', kind: 'claude', status: 'done' }],
        },
        {
          askId: 'old',
          conversationId: 'conversation-of-old',
          promptPreview: 'prompt of old',
          createdAt: T0,
          slots: [
            { slotId: 'a', providerId: 'claude', kind: 'claude', model: 'opus', status: 'done' },
            { slotId: 'b', providerId: 'codex', kind: 'codex', status: 'error' },
          ],
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(page)).not.toContain('secret');
  });

  test('an ask that is still running is listed too', async () => {
    await storage.turns.create(
      ask('live', 0, { status: 'running', slots: [slot('a', { status: 'running' })] }),
    );

    const page = await storage.turns.list(query());

    expect(page.items[0]?.slots[0]?.status).toBe('running');
  });

  test('the preview is cut to the preview length without splitting a character', async () => {
    const prompt = '🙂'.repeat(HISTORY_PREVIEW_CHARS + 50);
    await storage.turns.create(ask('long', 0, { prompt }));

    const [item] = (await storage.turns.list(query())).items;

    expect(item?.promptPreview).toBe('🙂'.repeat(HISTORY_PREVIEW_CHARS));
  });

  test('an empty history is one empty page', async () => {
    expect(await storage.turns.list(query())).toEqual({ items: [], nextCursor: null });
  });

  test('turns created in the same millisecond are ordered by insertion, newest first', async () => {
    for (const id of ['first', 'second', 'third']) await storage.turns.create(ask(id, 0));

    expect(await listedIds()).toEqual(['third', 'second', 'first']);
  });
});

describe('paging', () => {
  const createMany = async (count: number) => {
    for (let n = 1; n <= count; n++) await storage.turns.create(ask(`ask-${n}`, n));
  };

  const walk = async (input: Partial<Record<keyof HistoryQuery, unknown>>) => {
    const pages: string[][] = [];
    let cursor: string | null | undefined;
    do {
      const page = await storage.turns.list(query({ ...input, cursor: cursor ?? undefined }));
      pages.push(page.items.map((item) => item.askId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return pages;
  };

  test('walking the cursor visits every row once, in order', async () => {
    await createMany(7);

    expect(await walk({ limit: 3 })).toEqual([
      ['ask-7', 'ask-6', 'ask-5'],
      ['ask-4', 'ask-3', 'ask-2'],
      ['ask-1'],
    ]);
  });

  test('a page that ends exactly at the last row has no next cursor', async () => {
    await createMany(4);

    expect(await walk({ limit: 2 })).toEqual([
      ['ask-4', 'ask-3'],
      ['ask-2', 'ask-1'],
    ]);
  });

  test('the default page size applies when no limit is given', async () => {
    await createMany(35);

    const page = await storage.turns.list(query());

    expect(page.items).toHaveLength(30);
    expect(page.nextCursor).not.toBeNull();
  });

  test('a cursor stays valid while newer asks arrive: nothing is repeated or skipped', async () => {
    await createMany(4);
    const first = await storage.turns.list(query({ limit: 2 }));

    await storage.turns.create(ask('newer-1', 10));
    await storage.turns.create(ask('newer-2', 11));
    const second = await storage.turns.list(query({ limit: 2, cursor: first.nextCursor }));

    expect(second.items.map((item) => item.askId)).toEqual(['ask-2', 'ask-1']);
  });

  test('a cursor stays valid when rows are deleted, including the row it was taken from', async () => {
    await createMany(6);
    const first = await storage.turns.list(query({ limit: 2 }));
    expect(first.items.map((item) => item.askId)).toEqual(['ask-6', 'ask-5']);

    await storage.turns.delete('ask-5');
    await storage.turns.delete('ask-3');
    const second = await storage.turns.list(query({ limit: 2, cursor: first.nextCursor }));

    expect(second.items.map((item) => item.askId)).toEqual(['ask-4', 'ask-2']);
  });

  test('paging through rows with one timestamp neither repeats nor loses any', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) await storage.turns.create(ask(id, 0));

    expect(await walk({ limit: 2 })).toEqual([['e', 'd'], ['c', 'b'], ['a']]);
  });

  test('the cursor combines with a search', async () => {
    await createMany(6);
    for (const n of [2, 4, 6]) {
      await storage.turns.create(ask(`match-${n}`, n, { prompt: 'needle in here' }));
    }

    expect(await walk({ limit: 2, q: 'needle' })).toEqual([['match-6', 'match-4'], ['match-2']]);
  });

  test.each(['garbage', '1.2.3', '-1.5', 'zzzzzzzzzzzzzz.1', '.', '1.'])(
    'the cursor %j is rejected as a bad request',
    async (cursor) => {
      await expect(storage.turns.list(query({ cursor }))).rejects.toMatchObject({
        name: 'AppError',
        code: 'bad_request',
      });
    },
  );
});

describe('search', () => {
  beforeEach(async () => {
    await storage.turns.create(
      ask('sky', 1, {
        prompt: 'Why is the Sky blue?',
        slots: [
          slot('a', { text: 'Because of Rayleigh scattering.', reasoning: 'hidden-thought' }),
        ],
      }),
    );
    await storage.turns.create(
      ask('weather', 2, {
        prompt: '明天台北的天氣如何？',
        slots: [slot('a', { text: '多雲時晴，氣溫 25 度。' }), slot('b', { text: 'Sunny.' })],
      }),
    );
    await storage.turns.create(
      ask('escape', 3, {
        prompt: '100% sure? under_score and back\\slash',
        slots: [slot('a', { text: 'Über-Antwort mit Größe' })],
      }),
    );
  });

  test('matches a substring of the prompt, ignoring case', async () => {
    expect(await listedIds({ q: 'SKY BL' })).toEqual(['sky']);
    expect(await listedIds({ q: 'sky' })).toEqual(['sky']);
  });

  test('matches a substring of any answer', async () => {
    expect(await listedIds({ q: 'rayleigh' })).toEqual(['sky']);
    expect(await listedIds({ q: 'sunny' })).toEqual(['weather']);
  });

  test('does not search the reasoning', async () => {
    expect(await listedIds({ q: 'hidden-thought' })).toEqual([]);
  });

  test('finds Chinese text, including words of one or two characters', async () => {
    expect(await listedIds({ q: '天氣' })).toEqual(['weather']);
    expect(await listedIds({ q: '晴' })).toEqual(['weather']);
    expect(await listedIds({ q: '下雨' })).toEqual([]);
  });

  test('ignores case beyond ASCII for the usual spellings', async () => {
    expect(await listedIds({ q: 'über' })).toEqual(['escape']);
    expect(await listedIds({ q: 'ÜBER-ANTWORT' })).toEqual(['escape']);
    expect(await listedIds({ q: 'GRÖSSE' })).toEqual([]);
    expect(await listedIds({ q: 'größe' })).toEqual(['escape']);
  });

  test('treats the wildcard characters of LIKE literally', async () => {
    expect(await listedIds({ q: '100%' })).toEqual(['escape']);
    expect(await listedIds({ q: '%' })).toEqual(['escape']);
    expect(await listedIds({ q: 'under_score' })).toEqual(['escape']);
    expect(await listedIds({ q: 'under-score' })).toEqual([]);
    expect(await listedIds({ q: '_' })).toEqual(['escape']);
    expect(await listedIds({ q: 'back\\slash' })).toEqual(['escape']);
  });

  test('a quote in the query is data, not SQL', async () => {
    expect(await listedIds({ q: `' OR 1=1 --` })).toEqual([]);
  });

  test('several matches come newest first; no match is an empty page', async () => {
    expect(await listedIds({ q: 's' })).toEqual(['escape', 'weather', 'sky']);
    expect(await storage.turns.list(query({ q: 'no such text' }))).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test('an empty query lists everything', async () => {
    expect(await listedIds({ q: '' })).toEqual(['escape', 'weather', 'sky']);
  });
});

describe('delete', () => {
  test('removes a finished turn with its slot runs', async () => {
    await storage.turns.create(ask('gone', 0, { slots: [slot('a', { text: 'findable-answer' })] }));
    await storage.turns.create(ask('kept', 1));

    expect(await storage.turns.delete('gone')).toBe('deleted');

    expect(await storage.turns.get('gone')).toBeNull();
    expect(await listedIds()).toEqual(['kept']);
    expect(await listedIds({ q: 'findable-answer' })).toEqual([]);
  });

  test('refuses a turn that is still in progress', async () => {
    await storage.turns.create(ask('live', 0, { status: 'running' }));

    expect(await storage.turns.delete('live')).toBe('in_progress');

    expect(await storage.turns.get('live')).not.toBeNull();
  });

  test('reports an unknown turn', async () => {
    expect(await storage.turns.delete('nope')).toBe('not_found');
  });

  test('the same id can be used again after a delete', async () => {
    await storage.turns.create(ask('again', 0, { prompt: 'first life' }));
    await storage.turns.delete('again');

    await storage.turns.create(ask('again', 1, { prompt: 'second life' }));

    expect((await storage.turns.get('again'))?.prompt).toBe('second life');
  });
});

describe('prune', () => {
  /** An ask whose prompt and answer together are exactly `bytes` bytes. */
  const sized = (askId: string, minute: number, bytes: number): AskSnapshot =>
    ask(askId, minute, { prompt: 'p', slots: [slot('a', { text: 'x'.repeat(bytes - 1) })] });

  test('keeps the newest asks up to the count bound', async () => {
    for (let n = 1; n <= 5; n++) await storage.turns.create(ask(`ask-${n}`, n));

    expect(await storage.turns.prune({ ...UNLIMITED, maxAsks: 2 })).toBe(3);

    expect(await listedIds()).toEqual(['ask-5', 'ask-4']);
    expect(await storage.turns.conversationExists('conversation-of-ask-1')).toBe(false);
    expect(await storage.turns.conversationExists('conversation-of-ask-5')).toBe(true);
  });

  test('deletes the oldest asks until the byte bound holds', async () => {
    for (let n = 1; n <= 4; n++) await storage.turns.create(sized(`ask-${n}`, n, 100));

    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 250 })).toBe(2);

    expect(await listedIds()).toEqual(['ask-4', 'ask-3']);
  });

  test('a total exactly at the byte bound is within it', async () => {
    for (let n = 1; n <= 3; n++) await storage.turns.create(sized(`ask-${n}`, n, 100));

    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 300 })).toBe(0);
    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 299 })).toBe(1);
    expect(await listedIds()).toEqual(['ask-3', 'ask-2']);
  });

  test('sizes are bytes, not characters, and include prompt, answers and reasoning', async () => {
    // 3 + 3 + 3 = 9 bytes in 3 characters.
    await storage.turns.create(
      ask('wide', 1, { prompt: '天', slots: [slot('a', { text: '氣', reasoning: '晴' })] }),
    );

    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 9 })).toBe(0);
    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 8 })).toBe(1);
  });

  test('the size follows the answers as they are saved', async () => {
    const growing = ask('growing', 2, { prompt: 'p', slots: [slot('a'), slot('b')] });
    await storage.turns.create(sized('older', 1, 10));
    await storage.turns.create(growing);
    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 20 })).toBe(0);

    await storage.turns.save(
      { ...growing, slots: [slot('a', { text: 'x'.repeat(10) }), slot('b')] },
      ['a'],
    );
    await storage.turns.save(
      { ...growing, slots: [slot('a'), slot('b', { reasoning: 'y'.repeat(5) })] },
      ['b'],
    );

    // growing = 1 + 10 + 5 = 16 bytes; with the older 10 that exceeds 20.
    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 20 })).toBe(1);
    expect(await listedIds()).toEqual(['growing']);
  });

  test('a single ask larger than the byte bound is deleted too', async () => {
    await storage.turns.create(sized('huge', 1, 1000));

    expect(await storage.turns.prune({ ...UNLIMITED, maxBytes: 999 })).toBe(1);
    expect(await listedIds()).toEqual([]);
  });

  test('both bounds apply together', async () => {
    for (let n = 1; n <= 6; n++) await storage.turns.create(sized(`ask-${n}`, n, 100));

    expect(await storage.turns.prune({ maxAsks: 4, maxBytes: 250 })).toBe(4);
    expect(await listedIds()).toEqual(['ask-6', 'ask-5']);
  });

  test('never deletes an ask in flight, and does not count it against the bounds', async () => {
    await storage.turns.create(sized('done-old', 1, 100));
    await storage.turns.create({ ...sized('live-old', 2, 500), status: 'running' });
    await storage.turns.create(sized('done-new', 3, 100));
    await storage.turns.create({ ...sized('live-new', 4, 500), status: 'running' });

    expect(await storage.turns.prune({ maxAsks: 1, maxBytes: 150 })).toBe(1);

    expect(await listedIds()).toEqual(['live-new', 'done-new', 'live-old']);
  });

  test('within the bounds nothing is deleted', async () => {
    for (let n = 1; n <= 3; n++) await storage.turns.create(ask(`ask-${n}`, n));

    expect(await storage.turns.prune({ maxAsks: 3, maxBytes: 1_000_000 })).toBe(0);
    expect(await listedIds()).toHaveLength(3);
  });

  test('an empty history prunes to nothing', async () => {
    expect(await storage.turns.prune({ maxAsks: 1, maxBytes: 1 })).toBe(0);
  });

  test('only one turn of a shared conversation going keeps the conversation', async () => {
    await storage.turns.create(ask('one', 1, { conversationId: 'talk' }));
    await storage.turns.create(ask('two', 2, { conversationId: 'talk' }));

    expect(await storage.turns.prune({ ...UNLIMITED, maxAsks: 1 })).toBe(1);

    expect(await storage.turns.conversationExists('talk')).toBe(true);
    expect(await listedIds()).toEqual(['two']);
  });
});

describe('on disk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-turns-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('history survives closing and reopening the file', async () => {
    const file = join(dir, 'history.sqlite');
    const logger = createMemoryLogger();
    const first = await createSqliteStorage({ file, logger });
    const stored = ask('kept', 0, { slots: [slot('a', { text: 'still here' })] });
    await first.turns.create(stored);
    await first.close();

    const second = await createSqliteStorage({ file, logger });

    expect(await second.turns.get('kept')).toEqual(stored);
    await second.close();
  });

  test('deleting a turn deletes its slot runs and its conversation rows', async () => {
    const file = join(dir, 'cascade.sqlite');
    const disk = await createSqliteStorage({ file, logger: createMemoryLogger() });
    await disk.turns.create(ask('gone', 0, { slots: [slot('a'), slot('b')] }));
    await disk.turns.delete('gone');
    await disk.close();

    const db = openConnection({ file });
    const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n;
    expect([count('turns'), count('slot_runs'), count('conversations')]).toEqual([0, 0, 0]);
    db.close();
  });

  test('pruning gives the space of deleted answers back to the file system', async () => {
    const file = join(dir, 'shrink.sqlite');
    const disk = await createSqliteStorage({ file, logger: createMemoryLogger() });
    for (let n = 1; n <= 8; n++) {
      await disk.turns.create(
        ask(`big-${n}`, n, { slots: [slot('a', { text: 'x'.repeat(256 * 1024) })] }),
      );
    }
    await disk.close();
    const before = statSync(file).size;

    const reopened = await createSqliteStorage({ file, logger: createMemoryLogger() });
    expect(await reopened.turns.prune({ ...UNLIMITED, maxAsks: 1 })).toBe(7);
    await reopened.close();

    expect(before).toBeGreaterThan(8 * 256 * 1024);
    expect(statSync(file).size).toBeLessThan(before / 4);
  });
});
