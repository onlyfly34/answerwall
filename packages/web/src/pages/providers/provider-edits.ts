/** Pure helpers that turn an edit on the providers page into the list `PUT /api/settings` takes. */
import type { ProviderInstance, ProviderInstanceInput } from '@answerwall/core/protocol';

/** The writable form of a stored instance. The stored API key is kept: no `apiKey` is sent. */
export function toInput(instance: ProviderInstance): ProviderInstanceInput {
  if (instance.kind !== 'openai-compat') return instance;
  const { hasApiKey: _hasApiKey, ...writable } = instance;
  return writable;
}

/** The whole list with `next` in place of the instance of the same id, or appended. */
export function withProvider(
  providers: readonly ProviderInstance[],
  next: ProviderInstanceInput,
): ProviderInstanceInput[] {
  const inputs = providers.map((provider) => (provider.id === next.id ? next : toInput(provider)));
  return providers.some((provider) => provider.id === next.id) ? inputs : [...inputs, next];
}

export function withoutProvider(
  providers: readonly ProviderInstance[],
  id: string,
): ProviderInstanceInput[] {
  return providers.filter((provider) => provider.id !== id).map(toInput);
}

export function addModel(input: ProviderInstanceInput, model: string): ProviderInstanceInput {
  const id = model.trim();
  return id === '' || input.models.includes(id)
    ? input
    : { ...input, models: [...input.models, id] };
}

/** Removing the default model also clears the default. */
export function removeModel(input: ProviderInstanceInput, model: string): ProviderInstanceInput {
  const models = input.models.filter((id) => id !== model);
  return input.defaultModel === model
    ? setDefaultModel({ ...input, models }, undefined)
    : { ...input, models };
}

export function setDefaultModel(
  input: ProviderInstanceInput,
  model: string | undefined,
): ProviderInstanceInput {
  const { defaultModel: _previous, ...rest } = input;
  return model === undefined ? rest : { ...rest, defaultModel: model };
}

/** A provider id from a label: "My LiteLLM (home)" becomes "my-litellm-home". */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}
