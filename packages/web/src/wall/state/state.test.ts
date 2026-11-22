import { describe, expect, test } from 'vitest';
import { createDefaultSettings, DEFAULT_LAYOUT } from '@answerwall/core/protocol';
import type { ProviderStatus } from '@answerwall/core/protocol';
import { readyProviderStatus } from '../../contracts/testing.ts';
import { askSnapshot, slotSnapshot } from '../test-support.tsx';
import { clampLayoutValue, effectiveLayout, gridTemplateColumns, LAYOUT_BOUNDS } from './layout.ts';
import {
  canSendTo,
  defaultSlots,
  effectiveModel,
  effortChoices,
  isWebProvider,
  modelChoices,
  providerIssue,
} from './providers.ts';
import { copyTarget, makeTarget, moveItem, newId, newSlotId, sameTargets } from './slots.ts';
import {
  formatBytes,
  formatDuration,
  isActivePhase,
  queuePosition,
  slotPhase,
  utf8Bytes,
} from './slot-view.ts';
import { viewportOfWidth } from './viewport.ts';

const [claudeInstance] = createDefaultSettings().providers;
if (!claudeInstance) throw new Error('the default settings list no provider');
const claude = readyProviderStatus(claudeInstance);

function withDetection(patch: Partial<NonNullable<ProviderStatus['detection']>>): ProviderStatus {
  const detection = claude.detection;
  if (!detection) throw new Error('a ready provider has a detection');
  return { ...claude, detection: { ...detection, ...patch } };
}

describe('layout', () => {
  test('automatic columns fill the row with cells of at least the minimum width', () => {
    expect(gridTemplateColumns({ mode: 'auto', minCellWidth: 360, columns: 3 })).toBe(
      'repeat(auto-fill, minmax(min(100%, 360px), 1fr))',
    );
  });

  test('fixed columns ignore the minimum width', () => {
    expect(gridTemplateColumns({ mode: 'fixed', minCellWidth: 360, columns: 5 })).toBe(
      'repeat(5, minmax(0, 1fr))',
    );
  });

  test('a tablet defaults to two columns, a desktop follows the settings', () => {
    expect(effectiveLayout(null, DEFAULT_LAYOUT, 'tablet')).toEqual({
      ...DEFAULT_LAYOUT,
      mode: 'fixed',
      columns: 2,
    });
    expect(effectiveLayout(null, DEFAULT_LAYOUT, 'desktop')).toEqual(DEFAULT_LAYOUT);
  });

  test('a layout chosen on the device wins on every viewport', () => {
    const chosen = { mode: 'fixed', minCellWidth: 300, columns: 4 } as const;
    expect(effectiveLayout(chosen, DEFAULT_LAYOUT, 'tablet')).toBe(chosen);
  });

  test('values are rounded and clamped to what the protocol accepts', () => {
    expect(LAYOUT_BOUNDS.columns).toEqual({ min: 1, max: 12 });
    expect(LAYOUT_BOUNDS.minCellWidth).toEqual({ min: 240, max: 1200 });
    expect(clampLayoutValue('columns', 0)).toBe(1);
    expect(clampLayoutValue('columns', 99)).toBe(12);
    expect(clampLayoutValue('columns', 2.6)).toBe(3);
    expect(clampLayoutValue('minCellWidth', 10)).toBe(240);
    expect(clampLayoutValue('minCellWidth', 5000)).toBe(1200);
  });

  test('the viewport class follows the shared breakpoints, inclusive', () => {
    expect(viewportOfWidth(320)).toBe('phone');
    expect(viewportOfWidth(639)).toBe('phone');
    expect(viewportOfWidth(640)).toBe('tablet');
    expect(viewportOfWidth(1023)).toBe('tablet');
    expect(viewportOfWidth(1024)).toBe('desktop');
  });
});

describe('providers', () => {
  test('a provider is reported with the reason it may not answer', () => {
    expect(providerIssue(undefined)).toBe('missing');
    expect(providerIssue({ ...claude, instance: { ...claude.instance, enabled: false } })).toBe(
      'disabled',
    );
    expect(providerIssue(withDetection({ installed: false }))).toBe('not_installed');
    expect(providerIssue(withDetection({ loggedIn: 'no' }))).toBe('not_logged_in');
    expect(providerIssue(withDetection({ loggedIn: 'unknown' }))).toBeUndefined();
    expect(providerIssue({ ...claude, detection: null })).toBeUndefined();
    expect(providerIssue(claude)).toBeUndefined();
  });

  test('only an enabled, configured provider is sent to', () => {
    expect(canSendTo(claude)).toBe(true);
    expect(canSendTo(withDetection({ loggedIn: 'no' }))).toBe(true);
    expect(canSendTo({ ...claude, instance: { ...claude.instance, enabled: false } })).toBe(false);
    expect(canSendTo(undefined)).toBe(false);
  });

  test('a slot runs with its own model, else the default of the provider', () => {
    const status = { ...claude, instance: { ...claude.instance, defaultModel: 'sonnet' } };
    expect(effectiveModel(status, makeTarget('a', 'claude'))).toBe('sonnet');
    expect(effectiveModel(status, makeTarget('a', 'claude', 'opus'))).toBe('opus');
    expect(effectiveModel(undefined, makeTarget('a', 'claude'))).toBeUndefined();
  });

  test('a model the provider no longer lists stays selectable for the slot that has it', () => {
    const ids = (slotModel?: string) =>
      modelChoices(claude, makeTarget('a', 'claude', slotModel)).map((model) => model.id);
    expect(ids()).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(ids('opus')).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(ids('retired')).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'retired']);
    expect(modelChoices(undefined, makeTarget('a', 'gone', 'm'))).toEqual([{ id: 'm' }]);
  });

  test('effort levels come from the effective model', () => {
    const status: ProviderStatus = {
      ...claude,
      instance: { ...claude.instance, defaultModel: 'opus' },
      models: [{ id: 'opus', efforts: ['low', 'high'] }, { id: 'haiku' }],
    };
    expect(effortChoices(status, makeTarget('a', 'claude'))).toEqual(['low', 'high']);
    expect(effortChoices(status, makeTarget('a', 'claude', 'haiku'))).toEqual([]);
    expect(effortChoices(status, makeTarget('a', 'claude', 'haiku', 'max'))).toEqual(['max']);
  });

  test('a fresh wall has one cell per enabled provider', () => {
    const statuses = createDefaultSettings().providers.map(readyProviderStatus);
    expect(defaultSlots(statuses)).toEqual([
      { slotId: 's-1', providerId: 'claude' },
      { slotId: 's-2', providerId: 'codex' },
      { slotId: 's-3', providerId: 'grok' },
    ]);
  });
});

describe('slots', () => {
  test('new ids are valid, prefixed and never one that is taken', () => {
    const taken = new Set<string>();
    for (let count = 0; count < 200; count += 1) {
      const id = newSlotId(taken);
      expect(id).toMatch(/^s-[a-z0-9]{10}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(newId('p', [])).toMatch(/^p-[a-z0-9]{10}$/);
  });

  test('targets carry no undefined members', () => {
    expect(Object.keys(makeTarget('a', 'claude'))).toEqual(['slotId', 'providerId']);
    expect(makeTarget('a', 'claude', 'opus', 'high')).toEqual({
      slotId: 'a',
      providerId: 'claude',
      model: 'opus',
      effort: 'high',
    });
    expect(copyTarget(slotSnapshot({ slotId: 'x', model: 'opus', text: 'answer' }))).toEqual({
      slotId: 'x',
      providerId: 'claude',
      model: 'opus',
    });
  });

  test('moving an item clamps the destination and leaves the input alone', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(list, 1, 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveItem(list, 1, -5)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveItem(list, -1, 2)).toEqual(list);
    expect(moveItem(list, 9, 0)).toEqual(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  test('target lists compare by content and order', () => {
    const a = [makeTarget('1', 'claude', 'opus'), makeTarget('2', 'codex')];
    expect(sameTargets(a, a.map(copyTarget))).toBe(true);
    expect(sameTargets(a, [...a].reverse())).toBe(false);
    expect(sameTargets(a, a.slice(0, 1))).toBe(false);
    expect(sameTargets(a, [makeTarget('1', 'claude', 'haiku'), makeTarget('2', 'codex')])).toBe(
      false,
    );
    expect(
      sameTargets(a, [
        makeTarget('1', 'claude', 'opus'),
        makeTarget('2', 'codex', undefined, 'high'),
      ]),
    ).toBe(false);
  });
});

describe('slot view', () => {
  test('a running slot is waiting until it has text or reasoning', () => {
    expect(slotPhase(undefined)).toBe('idle');
    expect(slotPhase(slotSnapshot())).toBe('queued');
    expect(slotPhase(slotSnapshot({ status: 'running' }))).toBe('waiting');
    expect(slotPhase(slotSnapshot({ status: 'running', reasoning: 'hm' }))).toBe('streaming');
    expect(slotPhase(slotSnapshot({ status: 'running', text: 'a' }))).toBe('streaming');
    for (const status of ['done', 'error', 'cancelled', 'timeout'] as const) {
      expect(slotPhase(slotSnapshot({ status }))).toBe(status);
      expect(isActivePhase(status)).toBe(false);
    }
    expect(isActivePhase('queued')).toBe(true);
    expect(isActivePhase('waiting')).toBe(true);
    expect(isActivePhase('streaming')).toBe(true);
    expect(isActivePhase('idle')).toBe(false);
  });

  test('the queue position counts queued slots of the same provider only', () => {
    const ask = askSnapshot([
      slotSnapshot({ slotId: 'a', status: 'running' }),
      slotSnapshot({ slotId: 'b' }),
      slotSnapshot({ slotId: 'c', providerId: 'codex', kind: 'codex' }),
      slotSnapshot({ slotId: 'd' }),
    ]);
    expect(queuePosition(ask, 'a')).toBeUndefined();
    expect(queuePosition(ask, 'b')).toBe(1);
    expect(queuePosition(ask, 'c')).toBe(1);
    expect(queuePosition(ask, 'd')).toBe(2);
    expect(queuePosition(ask, 'missing')).toBeUndefined();
  });

  test('durations tick in whole seconds and end with a decimal', () => {
    expect(formatDuration(7_400, false)).toBe('7 s');
    expect(formatDuration(7_400, true)).toBe('7.4 s');
    expect(formatDuration(65_000, false)).toBe('1:05');
    expect(formatDuration(3_725_000, true)).toBe('62:05');
    expect(formatDuration(-50, false)).toBe('0 s');
  });

  test('sizes are measured in UTF-8 bytes', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('答案')).toBe(6);
    expect(utf8Bytes('😀')).toBe(4);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('web providers', () => {
  const web: ProviderStatus = {
    instance: {
      id: 'web-claude',
      kind: 'web',
      site: 'claude',
      label: 'Claude (web)',
      enabled: true,
      concurrency: 2,
      models: [],
    },
    detection: null,
    detectedAt: null,
    detecting: false,
    models: [],
    toolAccess: 'unrestricted',
    webSearch: 'none',
  };
  const disabled: ProviderStatus = { ...web, instance: { ...web.instance, enabled: false } };

  test('a page that cannot frame a site neither sends to a web provider nor offers it', () => {
    expect(isWebProvider(web)).toBe(true);
    expect(isWebProvider(claude)).toBe(false);
    expect(providerIssue(web)).toBe('extension_only');
    expect(canSendTo(web)).toBe(false);
    expect(defaultSlots([claude, web])).toEqual([{ slotId: 's-1', providerId: 'claude' }]);
  });

  test('the wall page of the extension treats it like any enabled provider', () => {
    expect(providerIssue(web, true)).toBeUndefined();
    expect(canSendTo(web, true)).toBe(true);
    expect(defaultSlots([claude, web], true)).toEqual([
      { slotId: 's-1', providerId: 'claude' },
      { slotId: 's-2', providerId: 'web-claude' },
    ]);
  });

  test('a disabled web provider is disabled everywhere', () => {
    expect(providerIssue(disabled)).toBe('disabled');
    expect(providerIssue(disabled, true)).toBe('disabled');
    expect(canSendTo(disabled, true)).toBe(false);
  });
});
