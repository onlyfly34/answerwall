import { expect, test } from 'vitest';
import type { Storage } from '../contracts/index.ts';
import type { AskSnapshot, Settings } from '../protocol/index.ts';
import { answerScript, createFakeStorage } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, targets } from './test-harness.ts';

const hang: ScriptStep[] = [{ event: { type: 'start' } }, { hang: true }];
/** Thirty deltas, one every 100 ms, then the result at 3100 ms. */
const thirtyDeltas = answerScript(
  Array.from({ length: 30 }, (_, index) => `${index} `),
  100,
);

interface SaveCall {
  status: AskSnapshot['status'];
  seq: number;
  dirty: readonly string[] | undefined;
}

/** A storage that records every save and prune, and fails the saves it is told to. */
function recordingStorage() {
  const inner = createFakeStorage();
  const saves: SaveCall[] = [];
  const prunes: { maxAsks: number; maxBytes: number }[] = [];
  const control = { failSaves: 0, failPrune: false };
  const storage: Storage = {
    ...inner,
    turns: {
      ...inner.turns,
      async save(snapshot, dirtySlotIds) {
        saves.push({ status: snapshot.status, seq: snapshot.seq, dirty: dirtySlotIds });
        if (control.failSaves > 0) {
          control.failSaves--;
          throw new Error('database is locked');
        }
        return inner.turns.save(snapshot, dirtySlotIds);
      },
      async prune(bounds) {
        prunes.push(bounds);
        if (control.failPrune) throw new Error('database is locked');
        return inner.turns.prune(bounds);
      },
    },
  };
  return { storage, saves, prunes, control };
}

const errorsLogged = (h: ReturnType<typeof createHarness>): string[] =>
  h.logger.entries.filter((entry) => entry.level === 'error').map((entry) => entry.message);

test('accumulated text reaches storage on a throttle while the ask runs, and completely at its end', async () => {
  const { storage, saves } = recordingStorage();
  const h = createHarness({ storage, script: thirtyDeltas });
  const askId = await h.ask(targets('claude', 1));

  await h.clock.advance(999);
  expect(saves).toEqual([]);
  expect(await storage.turns.get(askId)).toMatchObject({ seq: 0, slots: [{ status: 'queued' }] });

  await h.clock.advance(1);
  expect(saves).toHaveLength(1);
  const midway = (await storage.turns.get(askId))!;
  expect(midway).toMatchObject({ status: 'running', slots: [{ status: 'running' }] });
  expect(midway.slots[0]!.text).toBe('0 1 2 3 4 5 6 7 8 ');
  expect(midway.seq).toBe(10);

  await h.clock.advance(5000);
  // Thirty-two events cost four writes: one per second, and the final one.
  expect(saves.map((save) => save.status)).toEqual(['running', 'running', 'running', 'done']);
  expect(await storage.turns.get(askId)).toEqual(await h.manager.snapshot(askId));
  expect((await storage.turns.get(askId))!.slots[0]).toMatchObject({
    status: 'done',
    text: Array.from({ length: 30 }, (_, index) => `${index} `).join(''),
  });
  expect(h.clock.pendingTimers).toBe(0);
});

test('a throttled save names only the slots that changed; the final save writes all of them', async () => {
  const { storage, saves } = recordingStorage();
  const h = createHarness({
    storage,
    script: (request) => (request.model === 'talks' ? thirtyDeltas : hang),
  });
  const askId = await h.ask([
    { slotId: 'quiet', providerId: 'claude', model: 'silent' },
    { slotId: 'busy', providerId: 'claude', model: 'talks' },
  ]);

  await h.clock.advance(1000);
  expect(saves[0]!.dirty).toEqual(expect.arrayContaining(['quiet', 'busy']));
  await h.clock.advance(1000);
  expect(saves[1]!.dirty).toEqual(['busy']);

  await h.manager.cancel(askId);
  await h.settle();
  expect(saves.at(-1)).toMatchObject({ status: 'done', dirty: undefined });
  expect(await storage.turns.get(askId)).toEqual(await h.manager.snapshot(askId));
});

test('an ask that produces nothing new is not saved again and keeps no flush timer', async () => {
  const { storage, saves } = recordingStorage();
  const h = createHarness({ storage, script: hang });
  const askId = await h.ask(targets('claude', 1));

  await h.clock.advance(60_000);
  expect(saves).toHaveLength(1);
  // Only the slot's timeout is still pending.
  expect(h.clock.pendingTimers).toBe(1);
  await h.manager.cancel(askId);
  await h.settle();
  expect(h.clock.pendingTimers).toBe(0);
});

test('a failed throttled save is logged and its slots are written by the next save', async () => {
  const { storage, saves, control } = recordingStorage();
  const h = createHarness({ storage, script: thirtyDeltas });
  const askId = await h.ask(targets('claude', 1));
  control.failSaves = 1;

  await h.clock.advance(1000);
  expect(saves).toHaveLength(1);
  expect((await storage.turns.get(askId))!.seq).toBe(0);
  expect(errorsLogged(h)).toEqual(['could not save an ask']);

  await h.clock.advance(1000);
  expect(saves[1]!.dirty).toEqual(['c1']);
  expect((await storage.turns.get(askId))!.slots[0]!.text).toContain('0 1 2 3 ');
  await h.clock.advance(5000);
  expect(await storage.turns.get(askId)).toEqual(await h.manager.snapshot(askId));
});

test('a failed final save is logged, never thrown, and the ask is still served from memory', async () => {
  const { storage, control } = recordingStorage();
  const h = createHarness({ storage });
  control.failSaves = 1;
  const askId = await h.ask(targets('claude', 1));

  expect(errorsLogged(h)).toEqual(['could not save an ask']);
  expect((await h.manager.snapshot(askId)).status).toBe('done');
  expect((await h.events(askId)).at(-1)?.type).toBe('ask_done');
  // Nothing logged carries the prompt or the answer.
  expect(JSON.stringify(h.logger.entries)).not.toMatch(/2 \+ 2|"ok"/);
});

test('history is pruned to the configured bounds after every finished ask', async () => {
  const { storage, prunes } = recordingStorage();
  const h = createHarness({
    storage,
    settings: (settings: Settings) => {
      settings.limits.historyMaxAsks = 2;
    },
  });
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    ids.push(await h.ask(targets('claude', 1), `prompt ${index}`));
    await h.clock.advance(1);
  }

  expect(prunes).toHaveLength(3);
  expect(prunes[0]).toEqual({
    maxAsks: 2,
    maxBytes: h.settings.get().limits.historyMaxBytes,
  });
  expect(await storage.turns.get(ids[0]!)).toBeNull();
  expect(await storage.turns.get(ids[2]!)).not.toBeNull();

  await h.settings.update({ limits: { historyMaxAsks: 1 } });
  await h.ask(targets('claude', 1), 'prompt 3');
  expect(prunes.at(-1)!.maxAsks).toBe(1);
});

test('a failed prune is logged and does not disturb the ask', async () => {
  const { storage, control } = recordingStorage();
  const h = createHarness({ storage });
  control.failPrune = true;
  const askId = await h.ask(targets('claude', 1));

  expect(errorsLogged(h)).toEqual(['could not prune history']);
  expect(await storage.turns.get(askId)).toEqual(await h.manager.snapshot(askId));
  control.failPrune = false;
  expect((await h.manager.snapshot(await h.ask(targets('claude', 1)))).status).toBe('done');
});
