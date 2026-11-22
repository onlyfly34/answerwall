import { createMemo, createSignal, createUniqueId, For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { LANGUAGES, LayoutSettingsSchema } from '@answerwall/core/protocol';
import type { Language, LayoutSettings, SettingsPatch } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import { LANGUAGE_NAMES } from '../language-names.ts';

const WIDTH = LayoutSettingsSchema.shape.minCellWidth;
const COLUMNS = LayoutSettingsSchema.shape.columns;

/**
 * Language, the wall's default layout, and the release check. Only the desktop
 * app checks for releases, so a server shows no switch for it.
 */
export const GeneralSection: Component<{ save(patch: SettingsPatch): Promise<boolean> }> = (
  props,
) => {
  const { settings, meta, i18n } = useServices();
  const t = i18n.t;
  const ids = {
    language: createUniqueId(),
    width: createUniqueId(),
    columns: createUniqueId(),
    update: createUniqueId(),
  };
  const layout = (): LayoutSettings | undefined => settings.settings()?.layout;
  // Memos: a field is rewritten only when its own number changes, not on every
  // settings update, which would erase what is being typed while a save is pending.
  const minCellWidth = createMemo(() => layout()?.minCellWidth);
  const columns = createMemo(() => layout()?.columns);
  const [invalid, setInvalid] = createSignal<'minCellWidth' | 'columns'>();

  function changeLanguage(language: Language): void {
    // Applied at once; the save makes it the language of the other devices too.
    i18n.setLanguage(language);
    void props.save({ language });
  }

  function changeNumber(field: 'minCellWidth' | 'columns', text: string): void {
    const parsed = LayoutSettingsSchema.shape[field].safeParse(Number(text));
    setInvalid(parsed.success ? undefined : field);
    if (parsed.success && parsed.data !== layout()?.[field]) {
      void props.save({ layout: { [field]: parsed.data } });
    }
  }

  return (
    <>
      <section class="app-card" aria-labelledby={`${ids.language}-title`}>
        <h2 id={`${ids.language}-title`}>{t('app.settings.language.title')}</h2>
        <div class="app-field">
          <label for={ids.language}>{t('app.settings.language.label')}</label>
          <select
            id={ids.language}
            class="app-input"
            onChange={(event) => changeLanguage(event.currentTarget.value as Language)}
          >
            <For each={LANGUAGES}>
              {(language) => (
                <option value={language} selected={i18n.language() === language}>
                  {LANGUAGE_NAMES[language]}
                </option>
              )}
            </For>
          </select>
        </div>
      </section>

      <section class="app-card" aria-labelledby={`${ids.width}-title`}>
        <h2 id={`${ids.width}-title`}>{t('app.settings.layout.title')}</h2>
        <p class="app-muted">{t('app.settings.layout.intro')}</p>
        <fieldset class="app-field">
          <legend>{t('app.settings.layout.mode')}</legend>
          <label class="app-check">
            <input
              type="radio"
              name="layout-mode"
              checked={layout()?.mode === 'auto'}
              onChange={() => void props.save({ layout: { mode: 'auto' } })}
            />
            {t('app.settings.layout.auto')}
          </label>
          <label class="app-check">
            <input
              type="radio"
              name="layout-mode"
              checked={layout()?.mode === 'fixed'}
              onChange={() => void props.save({ layout: { mode: 'fixed' } })}
            />
            {t('app.settings.layout.fixed')}
          </label>
        </fieldset>
        <div class="app-fields">
          <div class="app-field">
            <label for={ids.width}>{t('app.settings.layout.minCellWidth')}</label>
            <input
              id={ids.width}
              class="app-input is-narrow"
              type="number"
              inputMode="numeric"
              min={WIDTH.minValue ?? undefined}
              max={WIDTH.maxValue ?? undefined}
              step={10}
              value={minCellWidth()}
              aria-invalid={invalid() === 'minCellWidth'}
              aria-describedby={`${ids.width}-help`}
              onChange={(event) => changeNumber('minCellWidth', event.currentTarget.value)}
            />
            <span
              id={`${ids.width}-help`}
              classList={{
                'app-muted': invalid() !== 'minCellWidth',
                'app-error': invalid() === 'minCellWidth',
              }}
            >
              {t('app.settings.range', { min: WIDTH.minValue ?? '', max: WIDTH.maxValue ?? '' })}
            </span>
          </div>
          <div class="app-field">
            <label for={ids.columns}>{t('app.settings.layout.columns')}</label>
            <input
              id={ids.columns}
              class="app-input is-narrow"
              type="number"
              inputMode="numeric"
              min={COLUMNS.minValue ?? undefined}
              max={COLUMNS.maxValue ?? undefined}
              step={1}
              value={columns()}
              aria-invalid={invalid() === 'columns'}
              aria-describedby={`${ids.columns}-help`}
              onChange={(event) => changeNumber('columns', event.currentTarget.value)}
            />
            <span
              id={`${ids.columns}-help`}
              classList={{
                'app-muted': invalid() !== 'columns',
                'app-error': invalid() === 'columns',
              }}
            >
              {t('app.settings.range', {
                min: COLUMNS.minValue ?? '',
                max: COLUMNS.maxValue ?? '',
              })}
            </span>
          </div>
        </div>
      </section>

      <Show when={meta()?.mode === 'desktop'}>
        <section class="app-card" aria-labelledby={`${ids.update}-title`}>
          <h2 id={`${ids.update}-title`}>{t('app.settings.update.title')}</h2>
          <div class="app-check">
            <input
              id={ids.update}
              type="checkbox"
              checked={settings.settings()?.updateCheck}
              aria-describedby={`${ids.update}-help`}
              onChange={(event) => void props.save({ updateCheck: event.currentTarget.checked })}
            />
            <label for={ids.update}>{t('app.settings.update.label')}</label>
          </div>
          <p id={`${ids.update}-help`} class="app-muted">
            {t('app.settings.update.help')}
          </p>
        </section>
      </Show>
    </>
  );
};
