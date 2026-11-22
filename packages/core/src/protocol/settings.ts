import { z } from 'zod';
import { DEFAULT_LAYOUT, LayoutPatchSchema, LayoutSettingsSchema } from './layout.ts';
import { DEFAULT_LIMITS, LimitsPatchSchema, LimitsSchema } from './limits.ts';
import { DeploymentModeSchema, TlsModeSchema } from './meta.ts';
import {
  CLI_PROVIDER_KINDS,
  concurrencyBounds,
  ProviderInstanceInputSchema,
  ProviderInstanceSchema,
} from './providers.ts';
import type { CliProviderInstance, CliProviderKind } from './providers.ts';

export const LANGUAGES = ['en', 'zh-TW'] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;

export const MAX_PROVIDER_INSTANCES = 64;

const uniqueIds = (providers: readonly { id: string }[]) =>
  new Set(providers.map((p) => p.id)).size === providers.length;

/** A CLI provider is switched off with `enabled`, never removed; only endpoints come and go. */
const everyCliKind = (providers: readonly { id: string }[]) =>
  CLI_PROVIDER_KINDS.every((kind) => providers.some((p) => p.id === kind));
const everyCliKindMessage = `every CLI provider (${CLI_PROVIDER_KINDS.join(', ')}) must be listed; disable one instead of removing it`;

export const SettingsSchema = z.object({
  language: LanguageSchema,
  providers: z
    .array(ProviderInstanceSchema)
    .max(MAX_PROVIDER_INSTANCES)
    .refine(uniqueIds, { message: 'provider ids must be unique' })
    .refine(everyCliKind, { message: everyCliKindMessage }),
  limits: LimitsSchema,
  layout: LayoutSettingsSchema,
  /** The optional check for a newer release; the only third-party request the app can make. */
  updateCheck: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Body of `PUT /api/settings`. Omitted fields are unchanged. `providers`
 * replaces the whole list: it must still contain every CLI provider, and an
 * OpenAI-compatible endpoint missing from it is removed together with its
 * stored key. `limits` and `layout` are merged field by field.
 */
export const SettingsPatchSchema = z.object({
  language: LanguageSchema.optional(),
  providers: z
    .array(ProviderInstanceInputSchema)
    .max(MAX_PROVIDER_INSTANCES)
    .refine(uniqueIds, { message: 'provider ids must be unique' })
    .refine(everyCliKind, { message: everyCliKindMessage })
    .optional(),
  limits: LimitsPatchSchema.optional(),
  layout: LayoutPatchSchema.optional(),
  updateCheck: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Read-only facts about the running server that the settings page shows. */
export const ServerInfoSchema = z.object({
  mode: DeploymentModeSchema,
  tls: z.object({
    mode: TlsModeSchema,
    /** Plain HTTP is reachable from other machines; the UI shows a warning. */
    insecure: z.boolean(),
    /** PEM of the private CA to install on client devices (`auto` mode only). */
    caCertificatePem: z.string().nullable(),
  }),
  publicOrigins: z.array(z.string()),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const SettingsResponseSchema = z.object({
  settings: SettingsSchema,
  server: ServerInfoSchema,
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

const CLI_DEFAULTS: Record<CliProviderKind, { label: string; enabled: boolean; models: string[] }> =
  {
    claude: { label: 'Claude', enabled: true, models: ['fable', 'opus', 'sonnet', 'haiku'] },
    codex: { label: 'Codex', enabled: true, models: [] },
    agy: { label: 'Gemini (agy)', enabled: false, models: [] },
    grok: { label: 'Grok', enabled: true, models: [] },
    // Off until the user turns it on: without a configuration of its own the CLI
    // answers with a hosted default model the user never chose.
    opencode: { label: 'OpenCode', enabled: false, models: [] },
  };

/** Settings of a fresh installation. */
export function createDefaultSettings(): Settings {
  return {
    language: 'en',
    providers: CLI_PROVIDER_KINDS.map((kind): CliProviderInstance => ({
      id: kind,
      kind,
      label: CLI_DEFAULTS[kind].label,
      enabled: CLI_DEFAULTS[kind].enabled,
      concurrency: concurrencyBounds(kind).default,
      models: [...CLI_DEFAULTS[kind].models],
      useEnvApiKey: false,
      riskAcknowledged: false,
      webSearch: false,
    })),
    limits: { ...DEFAULT_LIMITS },
    layout: { ...DEFAULT_LAYOUT },
    updateCheck: true,
  };
}
