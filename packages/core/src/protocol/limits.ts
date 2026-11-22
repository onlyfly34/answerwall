import { z } from 'zod';

const KIB = 1024;
const MIB = 1024 * KIB;

export interface LimitSpec {
  readonly default: number;
  readonly min: number;
  /** Hard maximum: settings validation rejects anything above it. */
  readonly max: number;
}

export const LIMIT_SPECS = {
  maxTargetsPerAsk: { default: 32, min: 1, max: 64 },
  maxRequestBodyBytes: { default: MIB, min: 64 * KIB, max: 16 * MIB },
  maxPromptBytes: { default: 200 * KIB, min: KIB, max: 8 * MIB },
  maxAsksInFlight: { default: 4, min: 1, max: 16 },
  maxQueuedSlots: { default: 64, min: 1, max: 256 },
  /** Accumulated answer plus reasoning text; beyond it the slot is truncated and flagged. */
  maxOutputBytesPerSlot: { default: 2 * MIB, min: 16 * KIB, max: 64 * MIB },
  historyMaxAsks: { default: 1000, min: 1, max: 100_000 },
  historyMaxBytes: { default: 500 * MIB, min: MIB, max: 64 * 1024 * MIB },
  /** Failed sign-in and pairing attempts per minute per client address. */
  authFailuresPerMinute: { default: 10, min: 1, max: 100 },
  slotTimeoutMs: { default: 5 * 60_000, min: 5_000, max: 60 * 60_000 },
} as const satisfies Record<string, LimitSpec>;

export type LimitName = keyof typeof LIMIT_SPECS;

const bounded = (name: LimitName) =>
  z.number().int().min(LIMIT_SPECS[name].min).max(LIMIT_SPECS[name].max);

const limitsShape = {
  maxTargetsPerAsk: bounded('maxTargetsPerAsk'),
  maxRequestBodyBytes: bounded('maxRequestBodyBytes'),
  maxPromptBytes: bounded('maxPromptBytes'),
  maxAsksInFlight: bounded('maxAsksInFlight'),
  maxQueuedSlots: bounded('maxQueuedSlots'),
  maxOutputBytesPerSlot: bounded('maxOutputBytesPerSlot'),
  historyMaxAsks: bounded('historyMaxAsks'),
  historyMaxBytes: bounded('historyMaxBytes'),
  authFailuresPerMinute: bounded('authFailuresPerMinute'),
  slotTimeoutMs: bounded('slotTimeoutMs'),
} satisfies Record<LimitName, z.ZodType<number>>;

export const LimitsSchema = z
  .object(limitsShape)
  .refine((limits) => limits.maxPromptBytes < limits.maxRequestBodyBytes, {
    path: ['maxPromptBytes'],
    message: 'maxPromptBytes must be smaller than maxRequestBodyBytes',
  });
export type Limits = z.infer<typeof LimitsSchema>;

/** Partial update; the merged result must still satisfy {@link LimitsSchema}. */
export const LimitsPatchSchema = z.object(limitsShape).partial();
export type LimitsPatch = z.infer<typeof LimitsPatchSchema>;

export const DEFAULT_LIMITS: Limits = {
  maxTargetsPerAsk: LIMIT_SPECS.maxTargetsPerAsk.default,
  maxRequestBodyBytes: LIMIT_SPECS.maxRequestBodyBytes.default,
  maxPromptBytes: LIMIT_SPECS.maxPromptBytes.default,
  maxAsksInFlight: LIMIT_SPECS.maxAsksInFlight.default,
  maxQueuedSlots: LIMIT_SPECS.maxQueuedSlots.default,
  maxOutputBytesPerSlot: LIMIT_SPECS.maxOutputBytesPerSlot.default,
  historyMaxAsks: LIMIT_SPECS.historyMaxAsks.default,
  historyMaxBytes: LIMIT_SPECS.historyMaxBytes.default,
  authFailuresPerMinute: LIMIT_SPECS.authFailuresPerMinute.default,
  slotTimeoutMs: LIMIT_SPECS.slotTimeoutMs.default,
};
