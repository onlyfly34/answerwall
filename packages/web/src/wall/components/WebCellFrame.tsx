import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { WebSiteId } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import type { WebCellFrame as HostedFrame, WebCellHost } from '../../contracts/services.ts';
import { useWebCellRunner } from '../state/web-runner.ts';
import { Icon } from './Icon.tsx';

export interface WebCellFrameProps {
  slotId: string;
  site: WebSiteId;
  label: string;
  host: WebCellHost;
}

/**
 * The vendor's own page in a frame, with its controls: reload, open in a
 * tab, and whether the host's script answers from inside. The page keeps
 * working by hand whatever the state of the rule.
 */
export const WebCellFrame: Component<WebCellFrameProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;
  const runner = useWebCellRunner();
  // A cell is rebuilt when its provider changes, so the site is fixed for its lifetime.
  // eslint-disable-next-line solid/reactivity -- see above
  const info = props.host.site(props.site);
  const [hosted, setHosted] = createSignal<HostedFrame>();
  let element: HTMLIFrameElement | undefined;

  onMount(() => {
    if (!element) return;
    const frame = props.host.attach(element, props.site);
    const unregister = runner?.register(props.slotId, frame);
    setHosted(frame);
    onCleanup(() => {
      unregister?.();
      frame.dispose();
    });
  });

  function reload(): void {
    // The page is on another origin: it can only be sent to its address again.
    if (element && info) element.src = info.url;
  }

  return (
    <Show when={info} fallback={<p class="wall-cell-issue">{t('wall.web.noRule')}</p>}>
      {(site) => (
        <div class="wall-web">
          <div class="wall-web-bar">
            <span
              class="wall-web-connection"
              data-connection={hosted()?.connection() ?? 'loading'}
              data-testid="web-connection"
            >
              {t(`wall.web.connection.${hosted()?.connection() ?? 'loading'}`)}
            </span>
            <Show when={!site().verified}>
              <span class="wall-web-unverified" title={t('wall.web.unverifiedHint')}>
                {t('wall.web.unverified')}
              </span>
            </Show>
            <span class="wall-web-actions">
              <button
                type="button"
                class="wall-icon-button"
                aria-label={t('wall.web.reload', { label: props.label })}
                title={t('wall.web.reload', { label: props.label })}
                onClick={reload}
              >
                <Icon name="reload" />
              </button>
              <a
                class="wall-icon-button"
                href={site().url}
                target="_blank"
                rel="noreferrer"
                aria-label={t('wall.web.openTab', { label: props.label })}
                title={t('wall.web.openTab', { label: props.label })}
              >
                <Icon name="external" />
              </a>
            </span>
          </div>
          <iframe
            ref={element}
            class="wall-web-frame"
            src={site().url}
            title={t('wall.web.frameTitle', { label: props.label })}
            allow="clipboard-write"
          />
        </div>
      )}
    </Show>
  );
};
