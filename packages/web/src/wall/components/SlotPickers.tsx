import { For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { AskTarget, ProviderStatus } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import { effortChoices, modelChoices, providerIssue } from '../state/providers.ts';

export interface SlotChange {
  providerId?: string;
  /** `null` returns to the provider's default. */
  model?: string | null;
  effort?: string | null;
}

export interface SlotPickersProps {
  slot: AskTarget;
  status: ProviderStatus | undefined;
  onChange(change: SlotChange): void;
}

/** Provider, model and effort of one cell; they apply to the next ask. */
export const SlotPickers: Component<SlotPickersProps> = (props) => {
  const { i18n, providers } = useServices();
  const efforts = () => effortChoices(props.status, props.slot);

  const providerOptionLabel = (status: ProviderStatus): string => {
    const issue = providerIssue(status);
    return issue
      ? i18n.t('wall.picker.providerWithIssue', {
          label: status.instance.label,
          issue: i18n.t(`wall.issue.${issue}`),
        })
      : status.instance.label;
  };

  return (
    <div class="wall-pickers">
      <label class="wall-picker">
        <span class="wall-visually-hidden">{i18n.t('wall.picker.provider')}</span>
        <select
          value={props.slot.providerId}
          onChange={(event) =>
            props.onChange({ providerId: event.currentTarget.value, model: null, effort: null })
          }
        >
          <Show when={!props.status}>
            <option value={props.slot.providerId}>
              {i18n.t('wall.picker.providerWithIssue', {
                label: props.slot.providerId,
                issue: i18n.t('wall.issue.missing'),
              })}
            </option>
          </Show>
          <For each={providers.providers()}>
            {(status) => (
              <option
                value={status.instance.id}
                disabled={!status.instance.enabled}
                selected={status.instance.id === props.slot.providerId}
              >
                {providerOptionLabel(status)}
              </option>
            )}
          </For>
        </select>
      </label>
      <label class="wall-picker">
        <span class="wall-visually-hidden">{i18n.t('wall.picker.model')}</span>
        <select
          value={props.slot.model ?? ''}
          onChange={(event) =>
            props.onChange({ model: event.currentTarget.value || null, effort: null })
          }
        >
          <option value="" selected={props.slot.model === undefined}>
            {props.status?.instance.defaultModel
              ? i18n.t('wall.picker.defaultModelNamed', {
                  model: props.status.instance.defaultModel,
                })
              : i18n.t('wall.picker.defaultModel')}
          </option>
          <For each={modelChoices(props.status, props.slot)}>
            {(model) => (
              <option value={model.id} selected={model.id === props.slot.model}>
                {model.label ?? model.id}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={efforts().length > 0}>
        <label class="wall-picker">
          <span class="wall-visually-hidden">{i18n.t('wall.picker.effort')}</span>
          <select
            value={props.slot.effort ?? ''}
            onChange={(event) => props.onChange({ effort: event.currentTarget.value || null })}
          >
            <option value="" selected={props.slot.effort === undefined}>
              {i18n.t('wall.picker.defaultEffort')}
            </option>
            <For each={efforts()}>
              {(effort) => (
                <option value={effort} selected={effort === props.slot.effort}>
                  {effort}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
    </div>
  );
};
