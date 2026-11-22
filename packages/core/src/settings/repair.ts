import type { z } from 'zod';
import {
  CLI_PROVIDER_KINDS,
  CliProviderInstanceSchema,
  concurrencyBounds,
  createDefaultSettings,
  DEFAULT_LAYOUT,
  DEFAULT_LIMITS,
  DEFAULT_WEB_CELLS,
  ExtensionIdSchema,
  HttpUrlSchema,
  KINDS_REQUIRING_ACKNOWLEDGEMENT,
  LanguageSchema,
  LayoutSettingsSchema,
  LIMIT_SPECS,
  MAX_EXTENSION_IDS,
  MAX_PROVIDER_INSTANCES,
  ModelIdSchema,
  OpenAiCompatInstanceSchema,
  WEB_SITES,
  webProviderId,
  WebProviderInstanceSchema,
  webSearchSupport,
} from '../protocol/index.ts';
import type {
  CliProviderInstance,
  CliProviderKind,
  LayoutSettings,
  LimitName,
  Limits,
  OpenAiCompatInstance,
  ProviderKind,
  Settings,
  WebCellsSettings,
  WebProviderInstance,
} from '../protocol/index.ts';
import { withoutCredentials } from './base-url.ts';

/** A provider as persisted: `hasApiKey` is derived from the secret store, never stored. */
export type StoredProvider =
  CliProviderInstance | Omit<OpenAiCompatInstance, 'hasApiKey'> | WebProviderInstance;

/** The settings document as persisted. */
export type StoredSettings = Omit<Settings, 'providers'> & { providers: StoredProvider[] };

type Fields = Record<string, unknown>;

const MAX_MODELS = 200;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stored value when it is valid, else the fallback. */
function valid<S extends z.ZodType>(schema: S, value: unknown, fallback: z.output<S>): z.output<S> {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

/** A number is pulled into its range; anything else becomes the fallback. */
function clamped(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function repairLimits(stored: unknown): Limits {
  const fields = isFields(stored) ? stored : {};
  const limits = { ...DEFAULT_LIMITS };
  for (const name of Object.keys(LIMIT_SPECS) as LimitName[]) {
    const spec = LIMIT_SPECS[name];
    limits[name] = clamped(fields[name], spec.min, spec.max, spec.default);
  }
  if (limits.maxPromptBytes >= limits.maxRequestBodyBytes) {
    limits.maxPromptBytes = DEFAULT_LIMITS.maxPromptBytes;
    limits.maxRequestBodyBytes = DEFAULT_LIMITS.maxRequestBodyBytes;
  }
  return limits;
}

function repairLayout(stored: unknown): LayoutSettings {
  const fields = isFields(stored) ? stored : {};
  const shape = LayoutSettingsSchema.shape;
  return {
    mode: valid(shape.mode, fields.mode, DEFAULT_LAYOUT.mode),
    minCellWidth: valid(shape.minCellWidth, fields.minCellWidth, DEFAULT_LAYOUT.minCellWidth),
    columns: valid(shape.columns, fields.columns, DEFAULT_LAYOUT.columns),
  };
}

function repairConcurrency(kind: ProviderKind, stored: unknown): number {
  const bounds = concurrencyBounds(kind);
  return clamped(stored, bounds.min, bounds.max, bounds.default);
}

function repairModels(stored: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(stored)) return [...fallback];
  return stored
    .flatMap((model) => {
      const result = ModelIdSchema.safeParse(model);
      return result.success ? [result.data] : [];
    })
    .slice(0, MAX_MODELS);
}

function defaultModel(stored: unknown): { defaultModel?: string } {
  const result = ModelIdSchema.safeParse(stored);
  return result.success ? { defaultModel: result.data } : {};
}

function cliDefaults(kind: CliProviderKind): CliProviderInstance {
  const found = createDefaultSettings().providers.find(
    (provider): provider is CliProviderInstance => provider.id === kind,
  );
  if (!found) throw new Error(`The default settings lack the ${kind} provider`);
  return found;
}

function repairCliProvider(kind: CliProviderKind, fields: Fields): CliProviderInstance {
  const base = cliDefaults(kind);
  const shape = CliProviderInstanceSchema.shape;
  const riskAcknowledged = valid(
    shape.riskAcknowledged,
    fields.riskAcknowledged,
    base.riskAcknowledged,
  );
  const mayBeEnabled = !KINDS_REQUIRING_ACKNOWLEDGEMENT.includes(kind) || riskAcknowledged;
  return {
    id: kind,
    kind,
    label: valid(shape.label, fields.label, base.label),
    enabled: mayBeEnabled && valid(shape.enabled, fields.enabled, base.enabled),
    concurrency: repairConcurrency(kind, fields.concurrency),
    models: repairModels(fields.models, base.models),
    ...defaultModel(fields.defaultModel),
    useEnvApiKey: valid(shape.useEnvApiKey, fields.useEnvApiKey, base.useEnvApiKey),
    riskAcknowledged,
    // Absent in documents written before the switch existed; never on for a kind without it.
    webSearch:
      webSearchSupport(kind) === 'available' && valid(shape.webSearch, fields.webSearch, false),
  };
}

/** An endpoint cannot be invented: without a usable id and URL it is dropped. */
function repairEndpoint(fields: Fields): StoredProvider | null {
  const shape = OpenAiCompatInstanceSchema.shape;
  const id = shape.id.safeParse(fields.id);
  // Checked as a plain address: one with a credential in it is cleaned below, not dropped.
  const baseUrl = HttpUrlSchema.safeParse(fields.baseUrl);
  if (!id.success || !baseUrl.success) return null;
  return {
    id: id.data,
    kind: 'openai-compat',
    label: valid(shape.label, fields.label, id.data),
    enabled: valid(shape.enabled, fields.enabled, false),
    concurrency: repairConcurrency('openai-compat', fields.concurrency),
    models: repairModels(fields.models, []),
    ...defaultModel(fields.defaultModel),
    // An older version stored the address as typed; a credential in it must not stay in the database.
    baseUrl: withoutCredentials(baseUrl.data),
  };
}

/** A web provider is its site: without a known one it is dropped, and its id follows from it. */
function repairWebProvider(fields: Fields): WebProviderInstance | null {
  const shape = WebProviderInstanceSchema.shape;
  const site = shape.site.safeParse(fields.site);
  if (!site.success) return null;
  const known = WEB_SITES.find((candidate) => candidate.id === site.data);
  return {
    id: webProviderId(site.data),
    kind: 'web',
    label: valid(shape.label, fields.label, known?.label ?? site.data),
    enabled: valid(shape.enabled, fields.enabled, false),
    concurrency: repairConcurrency('web', fields.concurrency),
    models: [],
    site: site.data,
  };
}

/** Every switch that is not a stored `true` is off; ids that are not extension ids are dropped. */
function repairWebCells(stored: unknown): WebCellsSettings {
  const fields = isFields(stored) ? stored : {};
  const ids = Array.isArray(fields.extensionIds) ? fields.extensionIds : [];
  const extensionIds = [
    ...new Set(
      ids.flatMap((id) => {
        const result = ExtensionIdSchema.safeParse(id);
        return result.success ? [result.data] : [];
      }),
    ),
  ].slice(0, MAX_EXTENSION_IDS);
  return {
    enabled: fields.enabled === true,
    fillPrompt: fields.fillPrompt === true,
    readAnswer: fields.readAnswer === true,
    extensionIds: extensionIds.length > 0 ? extensionIds : [...DEFAULT_WEB_CELLS.extensionIds],
  };
}

const cliKindOf = (value: unknown): CliProviderKind | undefined =>
  CLI_PROVIDER_KINDS.find((kind) => kind === value);

function repairProviders(stored: unknown): StoredProvider[] {
  const providers = new Map<string, StoredProvider>();
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!isFields(entry)) continue;
    // A CLI provider is recognised by either field, so one damaged field does not lose it.
    const cliKind = cliKindOf(entry.kind) ?? cliKindOf(entry.id);
    const provider = cliKind
      ? repairCliProvider(cliKind, entry)
      : entry.kind === 'openai-compat'
        ? repairEndpoint(entry)
        : entry.kind === 'web'
          ? repairWebProvider(entry)
          : null;
    if (provider && !providers.has(provider.id)) providers.set(provider.id, provider);
  }
  // Every CLI provider always exists; one that is missing comes back with its defaults.
  for (const kind of CLI_PROVIDER_KINDS) {
    if (!providers.has(kind)) providers.set(kind, repairCliProvider(kind, {}));
  }
  const all = [...providers.values()];
  const surplus = all.length - MAX_PROVIDER_INSTANCES;
  if (surplus <= 0) return all;
  const dropped = new Set(
    all
      .filter((provider) => provider.kind === 'openai-compat' || provider.kind === 'web')
      .slice(-surplus)
      .map((provider) => provider.id),
  );
  return all.filter((provider) => !dropped.has(provider.id));
}

/**
 * Turns whatever was stored into a valid settings document, keeping every
 * value that is still valid: a document written by an older version, edited
 * by hand, or damaged must never keep the server from starting. Invalid
 * values fall back to their defaults, numeric limits are pulled into their
 * bounds, and every CLI provider is present afterwards.
 */
export function repairSettings(document: unknown): StoredSettings {
  const fields = isFields(document) ? document : {};
  const defaults = createDefaultSettings();
  return {
    language: valid(LanguageSchema, fields.language, defaults.language),
    providers: repairProviders(fields.providers),
    limits: repairLimits(fields.limits),
    layout: repairLayout(fields.layout),
    updateCheck:
      typeof fields.updateCheck === 'boolean' ? fields.updateCheck : defaults.updateCheck,
    webCells: repairWebCells(fields.webCells),
  };
}
