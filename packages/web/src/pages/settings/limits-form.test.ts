import { describe, expect, test } from 'vitest';
import { DEFAULT_LIMITS, LIMIT_SPECS, LimitsSchema } from '@answerwall/core/protocol';
import type { LimitName } from '@answerwall/core/protocol';
import { displayBounds, LIMIT_FIELDS, parseLimits, toDisplay } from './limits-form.ts';

const defaults = () => toDisplay(DEFAULT_LIMITS);

describe('limits form', () => {
  test('every limit of the protocol has exactly one field', () => {
    expect(LIMIT_FIELDS.map((field) => field.name).sort()).toEqual(Object.keys(LIMIT_SPECS).sort());
  });

  test('sizes are shown in KiB or MiB and the timeout in seconds', () => {
    expect(defaults()).toMatchObject({
      maxTargetsPerAsk: '32',
      maxRequestBodyBytes: '1024',
      maxPromptBytes: '200',
      maxOutputBytesPerSlot: '2048',
      historyMaxBytes: '500',
      slotTimeoutMs: '300',
      authFailuresPerMinute: '10',
    });
  });

  test('the defaults survive the round trip unchanged', () => {
    expect(parseLimits(defaults())).toEqual({ ok: true, limits: DEFAULT_LIMITS });
  });

  test('the bounds are the hard bounds of the protocol, in the shown unit', () => {
    expect(displayBounds('maxTargetsPerAsk')).toEqual({ min: 1, max: 64, default: 32 });
    expect(displayBounds('maxAsksInFlight')).toEqual({ min: 1, max: 16, default: 4 });
    expect(displayBounds('maxQueuedSlots')).toEqual({ min: 1, max: 256, default: 64 });
    expect(displayBounds('slotTimeoutMs')).toEqual({ min: 5, max: 3600, default: 300 });
    expect(displayBounds('maxPromptBytes')).toEqual({ min: 1, max: 8192, default: 200 });
    for (const { name } of LIMIT_FIELDS) {
      const bounds = displayBounds(name);
      expect(bounds.min, name).toBeLessThanOrEqual(bounds.default);
      expect(bounds.default, name).toBeLessThanOrEqual(bounds.max);
    }
  });

  test.each(LIMIT_FIELDS.map((field) => field.name))(
    '%s accepts both of its bounds and refuses the values just outside',
    (name: LimitName) => {
      const bounds = displayBounds(name);
      // The prompt and the request limit constrain each other; move the other out of the way.
      const roomy = {
        ...defaults(),
        maxRequestBodyBytes: String(displayBounds('maxRequestBodyBytes').max),
        maxPromptBytes: String(displayBounds('maxPromptBytes').min),
      };

      for (const value of [bounds.min, bounds.max]) {
        const result = parseLimits({ ...roomy, [name]: String(value) });
        if (name === 'maxRequestBodyBytes' || name === 'maxPromptBytes') {
          // Checked together below.
          if (!result.ok) expect(result.errors[name]).not.toBe('range');
        } else {
          expect(result.ok, `${name}=${value}`).toBe(true);
        }
      }
      for (const value of [bounds.min - 1, bounds.max + 1]) {
        const result = parseLimits({ ...roomy, [name]: String(value) });
        expect(result, `${name}=${value}`).toEqual({ ok: false, errors: { [name]: 'range' } });
      }
    },
  );

  test.each(['', '  ', 'abc', '1e999', '-5'])('%j is not a number within the bounds', (text) => {
    expect(parseLimits({ ...defaults(), maxAsksInFlight: text })).toEqual({
      ok: false,
      errors: { maxAsksInFlight: 'range' },
    });
  });

  test('a count cannot be a fraction', () => {
    expect(parseLimits({ ...defaults(), maxAsksInFlight: '2.5' })).toEqual({
      ok: false,
      errors: { maxAsksInFlight: 'range' },
    });
    expect(parseLimits({ ...defaults(), authFailuresPerMinute: '10.1' }).ok).toBe(false);
  });

  test('whatever is accepted satisfies the schema the server validates with', () => {
    const result = parseLimits({ ...defaults(), slotTimeoutMs: '7.25', historyMaxBytes: '1.5' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(LimitsSchema.safeParse(result.limits).success).toBe(true);
      expect(result.limits.slotTimeoutMs).toBe(7250);
    }
  });

  test('fractions of a unit are kept exactly: 1.5 KiB is 1536 bytes', () => {
    const result = parseLimits({ ...defaults(), maxPromptBytes: '1.5' });
    expect(result).toMatchObject({ ok: true, limits: { maxPromptBytes: 1536 } });
    if (result.ok) expect(toDisplay(result.limits).maxPromptBytes).toBe('1.5');
  });

  test('the prompt limit must stay below the request limit', () => {
    expect(
      parseLimits({ ...defaults(), maxPromptBytes: '1024', maxRequestBodyBytes: '1024' }),
    ).toEqual({ ok: false, errors: { maxPromptBytes: 'promptVsBody' } });
    expect(
      parseLimits({ ...defaults(), maxPromptBytes: '1023', maxRequestBodyBytes: '1024' }).ok,
    ).toBe(true);
  });

  test('every error is reported at once', () => {
    const result = parseLimits({ ...defaults(), maxAsksInFlight: '0', maxQueuedSlots: '999' });
    expect(result).toEqual({
      ok: false,
      errors: { maxAsksInFlight: 'range', maxQueuedSlots: 'range' },
    });
  });
});
