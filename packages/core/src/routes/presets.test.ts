import { describe, expect, test } from 'vitest';
import { API_PATHS, MAX_PRESETS, PresetSchema, PresetsResponseSchema } from '../protocol/index.ts';
import type { PresetInput } from '../protocol/index.ts';
import { createTestApp } from '../testing/index.ts';
import type { TestApp } from '../testing/index.ts';

const input = (overrides: Partial<PresetInput> = {}): PresetInput => ({
  name: 'Three models',
  slots: [
    { slotId: 'left', providerId: 'claude', model: 'opus', effort: 'high' },
    { slotId: 'right', providerId: 'codex' },
  ],
  ...overrides,
});

const errorCode = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const listed = async (t: TestApp) =>
  PresetsResponseSchema.parse(await (await t.request('GET', API_PATHS.presets)).json()).presets;

describe('PUT /api/presets/:id', () => {
  test('creates a preset with its name, targets and layout', async () => {
    const t = createTestApp();
    const body = input({ layout: { mode: 'fixed', minCellWidth: 400, columns: 2 } });

    const response = await t.request('PUT', API_PATHS.preset('p1'), body);

    expect(response.status).toBe(200);
    const preset = PresetSchema.parse(await response.json());
    expect(preset).toEqual({
      ...body,
      id: 'p1',
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    expect(await listed(t)).toEqual([preset]);
  });

  test('replaces an existing preset: rename, new targets, layout removed', async () => {
    const t = createTestApp();
    await t.request(
      'PUT',
      API_PATHS.preset('p1'),
      input({ layout: { mode: 'auto', minCellWidth: 300, columns: 3 } }),
    );
    const createdAt = t.clock.now();
    await t.clock.advance(60_000);

    const response = await t.request(
      'PUT',
      API_PATHS.preset('p1'),
      input({ name: 'Renamed', slots: [{ slotId: 'only', providerId: 'grok' }] }),
    );

    expect(PresetSchema.parse(await response.json())).toEqual({
      id: 'p1',
      name: 'Renamed',
      slots: [{ slotId: 'only', providerId: 'grok' }],
      createdAt,
      updatedAt: createdAt + 60_000,
    });
    expect(await listed(t)).toHaveLength(1);
  });

  test('trims the name and ignores fields the client may not set', async () => {
    const t = createTestApp();

    const response = await t.request('PUT', API_PATHS.preset('p1'), {
      ...input({ name: '  Padded  ' }),
      id: 'other-id',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(PresetSchema.parse(await response.json())).toMatchObject({
      id: 'p1',
      name: 'Padded',
      createdAt: t.clock.now(),
    });
  });

  test.each([
    ['an empty name', input({ name: '   ' })],
    ['a name that is too long', input({ name: 'n'.repeat(81) })],
    ['no targets', input({ slots: [] })],
    [
      'duplicate slot ids',
      input({
        slots: [
          { slotId: 'same', providerId: 'claude' },
          { slotId: 'same', providerId: 'codex' },
        ],
      }),
    ],
    [
      'more targets than an ask may have',
      input({
        slots: Array.from({ length: 65 }, (_, n) => ({ slotId: `s${n}`, providerId: 'claude' })),
      }),
    ],
    ['an invalid provider id', input({ slots: [{ slotId: 'a', providerId: 'Not Valid' }] })],
    ['a layout out of range', input({ layout: { mode: 'fixed', minCellWidth: 400, columns: 99 } })],
    ['a missing name', { slots: input().slots }],
  ])('rejects %s and stores nothing', async (_, body) => {
    const t = createTestApp();

    const response = await t.request('PUT', API_PATHS.preset('p1'), body);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('bad_request');
    expect(await listed(t)).toEqual([]);
  });

  test.each(['has.dot', 'has space', 'x'.repeat(65)])('rejects the id %j', async (id) => {
    const t = createTestApp();

    const response = await t.request('PUT', API_PATHS.preset(id), input());

    expect(response.status).toBe(400);
    expect(await listed(t)).toEqual([]);
  });

  test('rejects a body that is not JSON', async () => {
    const t = createTestApp();

    const response = await t.app.request(API_PATHS.preset('p1'), {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token-0123456789abcdef',
        'Content-Type': 'application/json',
      },
      body: '{"name": ',
    });

    expect(response.status).toBe(400);
  });

  test('refuses a new preset beyond the maximum, but still updates existing ones', async () => {
    const t = createTestApp();
    for (let n = 0; n < MAX_PRESETS; n++) {
      await t.deps.storage.presets.put({ ...input(), id: `p${n}`, createdAt: 1, updatedAt: 1 });
    }

    const tooMany = await t.request('PUT', API_PATHS.preset('one-more'), input());
    const update = await t.request('PUT', API_PATHS.preset('p0'), input({ name: 'Updated' }));

    expect(tooMany.status).toBe(409);
    expect(await errorCode(tooMany)).toBe('conflict');
    expect(update.status).toBe(200);
    expect(await listed(t)).toHaveLength(MAX_PRESETS);
  });
});

describe('GET /api/presets', () => {
  test('is empty at first', async () => {
    expect(await listed(createTestApp())).toEqual([]);
  });

  test('lists presets ordered by name', async () => {
    const t = createTestApp();
    await t.request('PUT', API_PATHS.preset('1'), input({ name: 'Zebra' }));
    await t.request('PUT', API_PATHS.preset('2'), input({ name: 'Apple' }));
    await t.request('PUT', API_PATHS.preset('3'), input({ name: 'Mango' }));

    expect((await listed(t)).map((preset) => preset.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});

describe('GET /api/presets/:id', () => {
  test('returns one preset', async () => {
    const t = createTestApp();
    await t.request('PUT', API_PATHS.preset('p1'), input());

    const response = await t.request('GET', API_PATHS.preset('p1'));

    expect(response.status).toBe(200);
    expect(PresetSchema.parse(await response.json())).toMatchObject({ id: 'p1', ...input() });
  });

  test('is 404 for an unknown preset', async () => {
    const response = await createTestApp().request('GET', API_PATHS.preset('nope'));

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });
});

describe('DELETE /api/presets/:id', () => {
  test('deletes the preset; a second delete is 404', async () => {
    const t = createTestApp();
    await t.request('PUT', API_PATHS.preset('p1'), input());

    const first = await t.request('DELETE', API_PATHS.preset('p1'));
    const second = await t.request('DELETE', API_PATHS.preset('p1'));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(second.status).toBe(404);
    expect(await listed(t)).toEqual([]);
  });
});

test('every preset route needs authentication', async () => {
  const t = createTestApp();
  await t.request('PUT', API_PATHS.preset('p1'), input());
  const json = { 'Content-Type': 'application/json' };

  const responses = await Promise.all([
    t.app.request(API_PATHS.presets),
    t.app.request(API_PATHS.preset('p1')),
    t.app.request(API_PATHS.preset('p1'), {
      method: 'PUT',
      headers: json,
      body: JSON.stringify(input()),
    }),
    t.app.request(API_PATHS.preset('p1'), { method: 'DELETE', headers: json, body: '{}' }),
  ]);

  expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
  expect(await listed(t)).toHaveLength(1);
});
