import { createUniqueId, onCleanup, onMount } from 'solid-js';
import type { JSX, ParentComponent } from 'solid-js';
import { Portal } from 'solid-js/web';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  /** Escape, the backdrop and the dialog's own cancel button all end here. */
  onClose(): void;
  /** The buttons, in a row under the content. */
  actions: JSX.Element;
}

/**
 * A modal dialog: focus moves into it, Tab stays inside, Escape closes, and
 * focus returns to where it was. Mount it to open, unmount it to close.
 */
export const Dialog: ParentComponent<DialogProps> = (props) => {
  const titleId = createUniqueId();
  let panel!: HTMLDivElement;
  const opener = document.activeElement;

  const focusable = (): HTMLElement[] => [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];

  onMount(() => (focusable()[0] ?? panel).focus());
  onCleanup(() => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <Portal>
      <div
        class="app-dialog-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <div
          ref={panel}
          class="app-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabindex="-1"
          onKeyDown={onKeyDown}
        >
          <h2 id={titleId}>{props.title}</h2>
          <div class="app-dialog-body">{props.children}</div>
          <div class="app-actions">{props.actions}</div>
        </div>
      </div>
    </Portal>
  );
};
