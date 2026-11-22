/**
 * The limits form shows sizes in KiB or MiB and durations in seconds; the
 * protocol stores bytes and milliseconds. This module converts both ways and
 * validates against the bounds the server enforces.
 */
import { LIMIT_SPECS, LimitsSchema } from '@answerwall/core/protocol';
import type { LimitName, Limits } from '@answerwall/core/protocol';

export type LimitUnit = 'count' | 'kib' | 'mib' | 'seconds' | 'perMinute';

const UNIT_SIZE: Record<LimitUnit, number> = {
  count: 1,
  perMinute: 1,
  kib: 1024,
  mib: 1024 * 1024,
  seconds: 1000,
};

/** In the order the form shows them. */
export const LIMIT_FIELDS: readonly { name: LimitName; unit: LimitUnit }[] = [
  { name: 'maxTargetsPerAsk', unit: 'count' },
  { name: 'maxAsksInFlight', unit: 'count' },
  { name: 'maxQueuedSlots', unit: 'count' },
  { name: 'slotTimeoutMs', unit: 'seconds' },
  { name: 'maxPromptBytes', unit: 'kib' },
  { name: 'maxRequestBodyBytes', unit: 'kib' },
  { name: 'maxOutputBytesPerSlot', unit: 'kib' },
  { name: 'historyMaxAsks', unit: 'count' },
  { name: 'historyMaxBytes', unit: 'mib' },
  { name: 'authFailuresPerMinute', unit: 'perMinute' },
];

const unitOf = (name: LimitName): LimitUnit =>
  LIMIT_FIELDS.find((field) => field.name === name)?.unit ?? 'count';

export interface DisplayBounds {
  min: number;
  max: number;
  default: number;
}

/** The limit's bounds in the unit the form shows. */
export function displayBounds(name: LimitName): DisplayBounds {
  const size = UNIT_SIZE[unitOf(name)];
  const spec = LIMIT_SPECS[name];
  return {
    min: Math.ceil(spec.min / size),
    max: Math.floor(spec.max / size),
    default: Math.round(spec.default / size),
  };
}

export type LimitsText = Record<LimitName, string>;

/** Stored values as the text of the form's inputs. A value between two units keeps its fraction. */
export function toDisplay(limits: Limits): LimitsText {
  const text = {} as LimitsText;
  for (const { name, unit } of LIMIT_FIELDS) text[name] = String(limits[name] / UNIT_SIZE[unit]);
  return text;
}

/** `range`: not a number within the bounds. `promptVsBody`: the prompt limit must be below the body limit. */
export type LimitError = 'range' | 'promptVsBody';

export type LimitsResult =
  { ok: true; limits: Limits } | { ok: false; errors: Partial<Record<LimitName, LimitError>> };

export function parseLimits(text: LimitsText): LimitsResult {
  const errors: Partial<Record<LimitName, LimitError>> = {};
  const limits = {} as Limits;
  for (const { name, unit } of LIMIT_FIELDS) {
    const entered = text[name].trim();
    const scaled = Number(entered) * UNIT_SIZE[unit];
    // A size or a duration may be a fraction of its unit (1.5 KiB, 7.5 s); a count may not.
    const value = UNIT_SIZE[unit] === 1 ? scaled : Math.round(scaled);
    const spec = LIMIT_SPECS[name];
    if (entered === '' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
      errors[name] = 'range';
    }
    limits[name] = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (limits.maxPromptBytes >= limits.maxRequestBodyBytes) {
    return { ok: false, errors: { maxPromptBytes: 'promptVsBody' } };
  }
  // The server's own schema has the last word.
  const parsed = LimitsSchema.safeParse(limits);
  if (parsed.success) return { ok: true, limits: parsed.data };
  for (const issue of parsed.error.issues) {
    const field = LIMIT_FIELDS.find((candidate) => candidate.name === issue.path[0]);
    if (field) errors[field.name] = 'range';
  }
  return { ok: false, errors };
}
