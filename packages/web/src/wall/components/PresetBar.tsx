import { createSignal, For, Match, Show, Switch } from 'solid-js';
import type { Component } from 'solid-js';
import { MAX_PRESETS } from '@answerwall/core/protocol';
import type { Preset } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import type { Presets } from '../state/presets.ts';

const NAME_MAX_LENGTH = 80;

export interface PresetBarProps {
  presets: Presets;
  defaultPresetId: string | null;
  /** The wall has cells, so it can be saved. */
  canSave: boolean;
}

type Mode = 'idle' | 'saving' | 'renaming' | 'deleting';

/** One-click preset switching, plus save, update, rename, delete and default. */
export const PresetBar: Component<PresetBarProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;
  const [mode, setMode] = createSignal<Mode>('idle');
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const active = () => props.presets.active();

  function open(next: Mode, initialName = ''): void {
    setName(initialName);
    setMode(next);
  }

  async function run(operation: () => Promise<boolean>): Promise<void> {
    setBusy(true);
    try {
      if (await operation()) setMode('idle');
    } finally {
      setBusy(false);
    }
  }

  function submitName(preset: Preset | undefined): void {
    const chosen = name().trim();
    if (chosen === '') return;
    const operation =
      mode() === 'renaming' && preset
        ? props.presets.rename(preset, chosen)
        : props.presets.saveAs(chosen);
    void run(() => operation);
  }

  return (
    <section class="wall-presets" aria-label={t('wall.presets.label')}>
      <Show when={props.presets.list().length > 0}>
        <ul class="wall-preset-list">
          <For each={props.presets.list()}>
            {(preset) => (
              <li>
                <button
                  type="button"
                  class="wall-chip"
                  aria-pressed={preset.id === active()?.id}
                  onClick={() => {
                    setMode('idle');
                    props.presets.apply(preset);
                  }}
                >
                  {preset.name}
                  <Show when={preset.id === props.defaultPresetId}>
                    <span class="wall-chip-note"> {t('wall.presets.defaultMark')}</span>
                  </Show>
                  <Show when={preset.id === active()?.id && props.presets.modified()}>
                    <span class="wall-chip-note"> {t('wall.presets.modifiedMark')}</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Switch>
        <Match when={mode() === 'saving' || mode() === 'renaming'}>
          <form
            class="wall-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitName(active());
            }}
          >
            <label class="wall-field">
              <span>{t('wall.presets.name')}</span>
              <input
                ref={(input) => queueMicrotask(() => input.focus())}
                type="text"
                maxLength={NAME_MAX_LENGTH}
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <button
              type="submit"
              class="wall-button wall-button-small wall-button-primary"
              disabled={busy() || name().trim() === ''}
            >
              {t(mode() === 'renaming' ? 'wall.presets.rename' : 'wall.presets.save')}
            </button>
            <button
              type="button"
              class="wall-button wall-button-small"
              onClick={() => setMode('idle')}
            >
              {t('wall.cancel')}
            </button>
          </form>
        </Match>
        <Match when={mode() === 'deleting' && active()}>
          {(preset) => (
            <div class="wall-inline-form" role="group">
              <span>{t('wall.presets.confirmDelete', { name: preset().name })}</span>
              <button
                type="button"
                class="wall-button wall-button-small wall-button-danger"
                disabled={busy()}
                onClick={() => void run(() => props.presets.remove(preset()))}
              >
                {t('wall.delete')}
              </button>
              <button
                type="button"
                class="wall-button wall-button-small"
                onClick={() => setMode('idle')}
              >
                {t('wall.cancel')}
              </button>
            </div>
          )}
        </Match>
        <Match when={mode() === 'idle'}>
          <div class="wall-preset-actions">
            <button
              type="button"
              class="wall-button wall-button-small"
              disabled={!props.canSave || props.presets.list().length >= MAX_PRESETS}
              onClick={() => open('saving')}
            >
              {t('wall.presets.saveAs')}
            </button>
            <Show when={active()}>
              {(preset) => (
                <>
                  <Show when={props.presets.modified()}>
                    <button
                      type="button"
                      class="wall-button wall-button-small"
                      disabled={busy() || !props.canSave}
                      onClick={() => void run(() => props.presets.updateActive())}
                    >
                      {t('wall.presets.update', { name: preset().name })}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="wall-button wall-button-small"
                    onClick={() => open('renaming', preset().name)}
                  >
                    {t('wall.presets.rename')}
                  </button>
                  <button
                    type="button"
                    class="wall-button wall-button-small"
                    aria-pressed={preset().id === props.defaultPresetId}
                    onClick={() =>
                      props.presets.setDefault(
                        preset().id === props.defaultPresetId ? undefined : preset(),
                      )
                    }
                  >
                    {t('wall.presets.default')}
                  </button>
                  <button
                    type="button"
                    class="wall-button wall-button-small"
                    onClick={() => open('deleting')}
                  >
                    {t('wall.delete')}
                  </button>
                </>
              )}
            </Show>
          </div>
        </Match>
      </Switch>
    </section>
  );
};
