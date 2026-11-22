/** What the wall derives from the providers store for pickers, warnings and sending. */
import type { AskTarget, ModelInfo, ProviderStatus } from '@answerwall/core/protocol';
import { makeTarget } from './slots.ts';

/**
 * `missing` and `disabled` block sending: the server refuses the whole ask.
 * `not_installed` and `not_logged_in` come from a cached detection that may be
 * out of date, so they only warn; the provider itself has the last word.
 */
export type ProviderIssue = 'missing' | 'disabled' | 'not_installed' | 'not_logged_in';

export function providerIssue(status: ProviderStatus | undefined): ProviderIssue | undefined {
  if (!status) return 'missing';
  if (!status.instance.enabled) return 'disabled';
  if (status.detection && !status.detection.installed) return 'not_installed';
  if (status.detection?.loggedIn === 'no') return 'not_logged_in';
  return undefined;
}

export function canSendTo(status: ProviderStatus | undefined): boolean {
  return status?.instance.enabled === true;
}

/** The model a slot runs with: its own, else the provider's default. */
export function effectiveModel(
  status: ProviderStatus | undefined,
  slot: AskTarget,
): string | undefined {
  return slot.model ?? status?.instance.defaultModel;
}

/** The provider's models, plus the slot's own when the provider no longer lists it. */
export function modelChoices(status: ProviderStatus | undefined, slot: AskTarget): ModelInfo[] {
  const models = status?.models ?? [];
  return slot.model !== undefined && !models.some((model) => model.id === slot.model)
    ? [...models, { id: slot.model }]
    : models;
}

/** Effort levels of the slot's effective model, plus the slot's own when it is not among them. */
export function effortChoices(status: ProviderStatus | undefined, slot: AskTarget): string[] {
  const modelId = effectiveModel(status, slot);
  const efforts = status?.models.find((model) => model.id === modelId)?.efforts ?? [];
  return slot.effort !== undefined && !efforts.includes(slot.effort)
    ? [...efforts, slot.effort]
    : efforts;
}

/** One slot per enabled provider: the wall of a fresh start. */
export function defaultSlots(providers: readonly ProviderStatus[]): AskTarget[] {
  return providers
    .filter((status) => status.instance.enabled)
    .map((status, index) => makeTarget(`s-${index + 1}`, status.instance.id));
}
