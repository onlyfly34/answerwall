import { z } from 'zod';
import { TimestampSchema } from './common.ts';

export const CLI_PROVIDER_KINDS = ['claude', 'codex', 'agy', 'grok'] as const;
export const CliProviderKindSchema = z.enum(CLI_PROVIDER_KINDS);
export type CliProviderKind = z.infer<typeof CliProviderKindSchema>;

export const PROVIDER_KINDS = [...CLI_PROVIDER_KINDS, 'openai-compat'] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export function isCliKind(kind: ProviderKind): kind is CliProviderKind {
  return kind !== 'openai-compat';
}

/** Kinds whose first enable requires the user to acknowledge the vendor's wording. */
export const KINDS_REQUIRING_ACKNOWLEDGEMENT: readonly ProviderKind[] = ['agy'];

export interface ConcurrencyBounds {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export function concurrencyBounds(kind: ProviderKind): ConcurrencyBounds {
  switch (kind) {
    case 'agy':
      return { min: 1, max: 1, default: 1 };
    case 'openai-compat':
      return { min: 1, max: 32, default: 4 };
    default:
      return { min: 1, max: 5, default: 2 };
  }
}

/** CLI kinds use the kind as id; OpenAI-compatible endpoints use a user-chosen slug. */
export const ProviderIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, at most 32');
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ModelIdSchema = z.string().trim().min(1).max(200);
export const EffortSchema = z.string().trim().min(1).max(64);

const instanceBase = {
  id: ProviderIdSchema,
  label: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  /** Bounded per kind, see {@link concurrencyBounds}. */
  concurrency: z.number().int(),
  /** User-editable list; the server merges it with the adapter's own model listing. */
  models: z.array(ModelIdSchema).max(200),
  defaultModel: ModelIdSchema.optional(),
};

const cliInstanceShape = {
  ...instanceBase,
  kind: CliProviderKindSchema,
  /** Keep API-key environment variables for the child process (switches billing away from the subscription). */
  useEnvApiKey: z.boolean(),
  /** The user accepted the vendor notice; only meaningful for {@link KINDS_REQUIRING_ACKNOWLEDGEMENT}. */
  riskAcknowledged: z.boolean(),
};

const openAiCompatBase = {
  ...instanceBase,
  kind: z.literal('openai-compat'),
  /** With or without a trailing `/v1`; the adapter normalises it. */
  baseUrl: z.url({ protocol: /^https?$/ }).max(2048),
};

interface InstanceRuleInput {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  concurrency: number;
  riskAcknowledged?: boolean;
}

function checkInstanceRules(instance: InstanceRuleInput, ctx: z.RefinementCtx): void {
  const cliKinds: readonly string[] = CLI_PROVIDER_KINDS;
  if (isCliKind(instance.kind) ? instance.id !== instance.kind : cliKinds.includes(instance.id)) {
    ctx.addIssue({
      code: 'custom',
      path: ['id'],
      message: 'a CLI provider uses its kind as id and no other provider may use that id',
    });
  }
  const bounds = concurrencyBounds(instance.kind);
  if (instance.concurrency < bounds.min || instance.concurrency > bounds.max) {
    ctx.addIssue({
      code: 'custom',
      path: ['concurrency'],
      message: `concurrency for ${instance.kind} must be between ${bounds.min} and ${bounds.max}`,
    });
  }
  if (
    instance.enabled &&
    KINDS_REQUIRING_ACKNOWLEDGEMENT.includes(instance.kind) &&
    instance.riskAcknowledged !== true
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['riskAcknowledged'],
      message: `${instance.kind} cannot be enabled before its notice is acknowledged`,
    });
  }
}

export const CliProviderInstanceSchema = z.object(cliInstanceShape);
export type CliProviderInstance = z.infer<typeof CliProviderInstanceSchema>;

export const OpenAiCompatInstanceSchema = z.object({
  ...openAiCompatBase,
  /** The key itself is write-only and lives in the secret store. */
  hasApiKey: z.boolean(),
});
export type OpenAiCompatInstance = z.infer<typeof OpenAiCompatInstanceSchema>;

/** A configured provider as the API returns it. */
export const ProviderInstanceSchema = z
  .discriminatedUnion('kind', [CliProviderInstanceSchema, OpenAiCompatInstanceSchema])
  .superRefine(checkInstanceRules);
export type ProviderInstance = z.infer<typeof ProviderInstanceSchema>;

/** A provider as the client writes it: same shape, but the API key replaces `hasApiKey`. */
export const ProviderInstanceInputSchema = z
  .discriminatedUnion('kind', [
    CliProviderInstanceSchema,
    z.object({
      ...openAiCompatBase,
      /** Omitted: keep the stored key. `null`: delete it. String: replace it. */
      apiKey: z.string().min(1).max(4096).nullable().optional(),
    }),
  ])
  .superRefine(checkInstanceRules);
export type ProviderInstanceInput = z.infer<typeof ProviderInstanceInputSchema>;

export const LoginStateSchema = z.enum(['yes', 'no', 'unknown']);
export type LoginState = z.infer<typeof LoginStateSchema>;

export const BillingSourceSchema = z.enum(['subscription', 'api-key', 'unknown']);
export type BillingSource = z.infer<typeof BillingSourceSchema>;

/** `block`: the provider emits whole messages, not token deltas. */
export const StreamingModeSchema = z.enum(['token', 'block', 'unknown']);
export type StreamingMode = z.infer<typeof StreamingModeSchema>;

/**
 * How far the provider's tools are switched off for question answering.
 * `none`: the provider has no tools. `disabled`: tools exist and are off.
 * `read-only`: tools cannot be disabled, only sandboxed. `unrestricted`: no
 * documented way to restrict them.
 */
export const ToolAccessSchema = z.enum(['none', 'disabled', 'read-only', 'unrestricted']);
export type ToolAccess = z.infer<typeof ToolAccessSchema>;

/** Result of an adapter's detect(); never contains account identifiers or absolute paths. */
export const ProviderDetectionSchema = z.object({
  installed: z.boolean(),
  version: z.string().max(64).optional(),
  loggedIn: LoginStateSchema,
  billing: BillingSourceSchema.optional(),
  streaming: StreamingModeSchema,
  hint: z.string().max(500).optional(),
});
export type ProviderDetection = z.infer<typeof ProviderDetectionSchema>;

export const ModelInfoSchema = z.object({
  id: ModelIdSchema,
  label: z.string().max(200).optional(),
  efforts: z.array(EffortSchema).max(16).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ProviderStatusSchema = z.object({
  instance: ProviderInstanceSchema,
  /** `null` until the first detection has finished. */
  detection: ProviderDetectionSchema.nullable(),
  detectedAt: TimestampSchema.nullable(),
  /** The instance's own list merged with the adapter's listing. */
  models: z.array(ModelInfoSchema),
  toolAccess: ToolAccessSchema,
  /** The exact official command the user runs in a terminal to log in. */
  loginCommand: z.string().max(200).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderStatusSchema),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

/** Without `id` every enabled provider is re-detected. */
export const RefreshProvidersRequestSchema = z.object({
  id: ProviderIdSchema.optional(),
});
export type RefreshProvidersRequest = z.infer<typeof RefreshProvidersRequestSchema>;
