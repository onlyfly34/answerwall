import { Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { LayoutSettings } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import { clampLayoutValue, LAYOUT_BOUNDS } from '../state/layout.ts';

export interface LayoutControlsProps {
  /** The layout in effect. */
  layout: LayoutSettings;
  /** The layout was chosen on this device rather than taken from the settings. */
  customised: boolean;
  onChange(layout: LayoutSettings): void;
  onReset(): void;
}

const MIN_WIDTH_STEP_PX = 20;

/** Automatic columns with a minimum cell width, or a fixed number of columns. */
export const LayoutControls: Component<LayoutControlsProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;

  function setNumber(field: 'columns' | 'minCellWidth', input: HTMLInputElement): void {
    const value = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(value)) {
      input.value = String(props.layout[field]);
      return;
    }
    const clamped = clampLayoutValue(field, value);
    input.value = String(clamped);
    props.onChange({ ...props.layout, [field]: clamped });
  }

  return (
    <fieldset class="wall-layout">
      <legend class="wall-visually-hidden">{t('wall.layout.label')}</legend>
      <label class="wall-field">
        <span>{t('wall.layout.mode')}</span>
        <select
          value={props.layout.mode}
          onChange={(event) =>
            props.onChange({
              ...props.layout,
              mode: event.currentTarget.value === 'fixed' ? 'fixed' : 'auto',
            })
          }
        >
          <option value="auto" selected={props.layout.mode === 'auto'}>
            {t('wall.layout.auto')}
          </option>
          <option value="fixed" selected={props.layout.mode === 'fixed'}>
            {t('wall.layout.fixed')}
          </option>
        </select>
      </label>
      <Show
        when={props.layout.mode === 'fixed'}
        fallback={
          <label class="wall-field">
            <span>{t('wall.layout.minWidth')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={LAYOUT_BOUNDS.minCellWidth.min}
              max={LAYOUT_BOUNDS.minCellWidth.max}
              step={MIN_WIDTH_STEP_PX}
              value={props.layout.minCellWidth}
              onChange={(event) => setNumber('minCellWidth', event.currentTarget)}
            />
          </label>
        }
      >
        <label class="wall-field">
          <span>{t('wall.layout.columns')}</span>
          <input
            type="number"
            inputMode="numeric"
            min={LAYOUT_BOUNDS.columns.min}
            max={LAYOUT_BOUNDS.columns.max}
            step={1}
            value={props.layout.columns}
            onChange={(event) => setNumber('columns', event.currentTarget)}
          />
        </label>
      </Show>
      <Show when={props.customised}>
        <button type="button" class="wall-button wall-button-small" onClick={() => props.onReset()}>
          {t('wall.layout.reset')}
        </button>
      </Show>
    </fieldset>
  );
};
