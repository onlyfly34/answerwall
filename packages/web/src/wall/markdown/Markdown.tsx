import { createEffect, on, onCleanup, onMount } from 'solid-js';
import type { Component } from 'solid-js';
import { useServices } from '../../contracts/services.ts';
import { copyText } from '../clipboard.ts';
import { COPY_CODE_ATTRIBUTE, createIncrementalMarkdown } from './incremental.ts';
import { createRenderScheduler } from './scheduler.ts';

/** How long a copy button shows its confirmation. */
export const COPIED_FEEDBACK_MS = 1500;

export interface MarkdownProps {
  text: string;
  /** The text will not grow any more: render the rest without waiting for the throttle. */
  final: boolean;
  /** A hidden cell does not render until it is shown again. */
  visible: boolean;
  /** Called after the DOM changed. */
  onRendered?: () => void;
}

/**
 * Streamed Markdown: the accumulated text is re-parsed on a throttle and the
 * sanitised result replaces the changed blocks. A delta is never turned into
 * HTML on its own.
 */
export const Markdown: Component<MarkdownProps> = (props) => {
  const { i18n } = useServices();
  let container!: HTMLDivElement;

  onMount(() => {
    const markdown = createIncrementalMarkdown(container, () => ({
      copy: i18n.t('wall.code.copy'),
    }));
    const scheduler = createRenderScheduler({
      render: () => {
        markdown.update(props.text);
        props.onRendered?.();
      },
    });
    onCleanup(() => scheduler.dispose());

    createEffect(
      on(
        () => props.text,
        () => scheduler.request(),
      ),
    );
    createEffect(() => {
      if (props.final) scheduler.flush();
    });
    createEffect(() => scheduler.setPaused(!props.visible));
    // The copy buttons carry translated text, so a language change re-renders.
    createEffect(
      on(
        i18n.language,
        () => {
          markdown.reset();
          scheduler.request();
          scheduler.flush();
        },
        { defer: true },
      ),
    );
  });

  const feedbackTimers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => feedbackTimers.forEach(clearTimeout));

  async function onClick(event: MouseEvent): Promise<void> {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest(`[${COPY_CODE_ATTRIBUTE}]`);
    const code = button?.closest('.wall-code')?.querySelector('pre');
    if (!button || !code) return;
    const copied = await copyText(code.textContent);
    button.textContent = i18n.t(copied ? 'wall.copied' : 'wall.copyFailed');
    const timer = setTimeout(() => {
      feedbackTimers.delete(timer);
      button.textContent = i18n.t('wall.code.copy');
    }, COPIED_FEEDBACK_MS);
    feedbackTimers.add(timer);
  }

  return <div ref={container} class="wall-markdown" onClick={(event) => void onClick(event)} />;
};
