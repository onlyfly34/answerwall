import { createSignal, createUniqueId } from 'solid-js';
import type { Component } from 'solid-js';
import { Dialog } from '../../app/ui/Dialog.tsx';
import { useServices } from '../../contracts/services.ts';

/** Where the vendor publishes the wording quoted below. */
export const AGY_FAQ_URL = 'https://antigravity.google/docs/faq';

/**
 * The vendor's own words, quoted verbatim and therefore not translated: the
 * FAQ says wrapping the CLI in a third-party application is not supported
 * under consumer plans.
 */
export const AGY_FAQ_QUOTE =
  'Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. ' +
  'Wrapping `agy` inside third-party coding agents or applications, or automating account ' +
  'rotation, is not supported under consumer plans.';

export interface AcknowledgeDialogProps {
  label: string;
  onConfirm(): void;
  onCancel(): void;
}

/** Shown before the provider is enabled for the first time; enabling needs an explicit tick. */
export const AcknowledgeDialog: Component<AcknowledgeDialogProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;
  const checkId = createUniqueId();
  const [accepted, setAccepted] = createSignal(false);

  return (
    <Dialog
      title={t('app.providers.risk.title', { label: props.label })}
      onClose={() => props.onCancel()}
      actions={
        <>
          <button type="button" class="app-button" onClick={() => props.onCancel()}>
            {t('app.cancel')}
          </button>
          <button
            type="button"
            class="app-button is-danger"
            disabled={!accepted()}
            onClick={() => props.onConfirm()}
          >
            {t('app.providers.risk.confirm')}
          </button>
        </>
      }
    >
      <p>{t('app.providers.risk.intro')}</p>
      <blockquote class="app-quote" lang="en" cite={AGY_FAQ_URL}>
        {AGY_FAQ_QUOTE}
      </blockquote>
      <p class="app-muted">
        {t('app.providers.risk.source')}{' '}
        <a href={AGY_FAQ_URL} target="_blank" rel="noopener noreferrer">
          {AGY_FAQ_URL}
        </a>
      </p>
      <p>{t('app.providers.risk.consequence')}</p>
      <div class="app-check">
        <input
          id={checkId}
          type="checkbox"
          checked={accepted()}
          onChange={(event) => setAccepted(event.currentTarget.checked)}
        />
        <label for={checkId}>{t('app.providers.risk.accept')}</label>
      </div>
    </Dialog>
  );
};
