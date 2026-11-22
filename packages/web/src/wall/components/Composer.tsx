import { Show } from 'solid-js';
import type { Component } from 'solid-js';
import { useServices } from '../../contracts/services.ts';
import { formatBytes } from '../state/slot-view.ts';
import { Icon } from './Icon.tsx';

/** From this share of the limit on, the composer shows the prompt's size. */
const SIZE_WARNING_SHARE = 0.8;

export interface ComposerProps {
  prompt: string;
  /** Size of the prompt on the wire. */
  promptBytes: number;
  maxPromptBytes: number;
  /** Number of cells the prompt would go to. */
  targetCount: number;
  /** Why sending is not possible right now, already translated; `undefined` when it is. */
  blocked: string | undefined;
  /** A submission is on its way to the server. */
  sending: boolean;
  /** The ask on the wall has unfinished cells. */
  running: boolean;
  onInput(prompt: string): void;
  onSend(): void;
  onCancelAll(): void;
}

const isApple = (): boolean => /mac|iphone|ipad/i.test(navigator.userAgent);

export const Composer: Component<ComposerProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;
  const canSend = () => props.blocked === undefined && !props.sending;
  const tooLong = () => props.promptBytes > props.maxPromptBytes;
  const showSize = () => props.promptBytes >= props.maxPromptBytes * SIZE_WARNING_SHARE;

  function onKeyDown(event: KeyboardEvent): void {
    // Enter alone is a line break; an Enter that confirms an input-method
    // composition is never a send.
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    if (canSend()) props.onSend();
  }

  return (
    <form
      class="wall-composer"
      aria-label={t('wall.composer.label')}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend()) props.onSend();
      }}
    >
      <label class="wall-visually-hidden" for="wall-prompt">
        {t('wall.composer.prompt')}
      </label>
      <textarea
        id="wall-prompt"
        class="wall-composer-input"
        rows={3}
        placeholder={t('wall.composer.placeholder')}
        value={props.prompt}
        aria-invalid={tooLong()}
        aria-describedby="wall-composer-hint"
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div class="wall-composer-bar">
        <p id="wall-composer-hint" class="wall-composer-hint">
          <Show
            when={props.blocked}
            fallback={t(isApple() ? 'wall.composer.hintApple' : 'wall.composer.hint')}
          >
            {(reason) => <span>{reason()}</span>}
          </Show>
          <Show when={showSize()}>
            <span classList={{ 'wall-composer-size': true, 'wall-danger': tooLong() }}>
              {' '}
              {t('wall.composer.size', {
                size: formatBytes(props.promptBytes),
                limit: formatBytes(props.maxPromptBytes),
              })}
            </span>
          </Show>
        </p>
        <Show when={props.running}>
          <button type="button" class="wall-button" onClick={() => props.onCancelAll()}>
            <Icon name="stop" />
            {t('wall.composer.cancelAll')}
          </button>
        </Show>
        <button type="submit" class="wall-button wall-button-primary" disabled={!canSend()}>
          {props.sending
            ? t('wall.composer.sending')
            : t('wall.composer.send', { count: props.targetCount })}
        </button>
      </div>
    </form>
  );
};
