import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { Accessor, Component } from 'solid-js';
import type {
  AskSnapshot,
  AskTarget,
  LayoutSettings,
  SlotSnapshot,
} from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import { gridTemplateColumns } from '../state/layout.ts';
import type { Viewport } from '../state/layout.ts';
import { queuePosition, slotPhase } from '../state/slot-view.ts';
import { Cell, cellPanelId, cellTabId } from './Cell.tsx';
import type { SlotChange } from './SlotPickers.tsx';

/** A horizontal swipe must travel this far (CSS px) and be this much wider than tall. */
const SWIPE_MIN_PX = 48;
const SWIPE_RATIO = 1.5;
/** A swipe that starts in one of these scrolls or edits it instead. */
const SWIPE_IGNORED = 'pre, table, select, textarea, input, [role="tablist"]';

export interface WallGridProps {
  slots: readonly AskTarget[];
  /** The ask whose answers the cells show. */
  ask: AskSnapshot | undefined;
  layout: LayoutSettings;
  viewport: Viewport;
  maximised: string | null;
  readOnly: boolean;
  now: Accessor<number>;
  onChange(slotId: string, change: SlotChange): void;
  onRemove(slotId: string): void;
  onDuplicate(slotId: string): void;
  onMaximise(slotId: string | null): void;
  onCancel(slotId: string): void;
  onMove(slotId: string, toIndex: number): void;
}

export const WallGrid: Component<WallGridProps> = (props) => {
  const { i18n, providers } = useServices();
  const t = i18n.t;

  // Cells are keyed by slot id, so reordering moves their elements instead of rebuilding them.
  const ids = createMemo(() => props.slots.map((slot) => slot.slotId));
  const slotOf = (slotId: string): AskTarget | undefined =>
    props.slots.find((slot) => slot.slotId === slotId);
  /** The slot's part of the ask; none once the cell was given to another provider. */
  const snapshotOf = (slotId: string): SlotSnapshot | undefined => {
    const providerId = slotOf(slotId)?.providerId;
    return props.ask?.slots.find(
      (slot) => slot.slotId === slotId && slot.providerId === providerId,
    );
  };
  const labelOf = (slotId: string): string => {
    const providerId = slotOf(slotId)?.providerId;
    return (
      providers.providers().find((provider) => provider.instance.id === providerId)?.instance
        .label ??
      providerId ??
      slotId
    );
  };

  const single = () => props.viewport === 'phone';

  // Phone: one cell at a time.
  const [chosen, setChosen] = createSignal<string>();
  const activeId = createMemo(() => {
    const current = chosen();
    return current !== undefined && ids().includes(current) ? current : ids()[0];
  });
  const shownAlone = (): string | undefined => {
    if (single()) return activeId();
    return props.maximised !== null && ids().includes(props.maximised)
      ? props.maximised
      : undefined;
  };

  let tablist: HTMLDivElement | undefined;
  function activate(slotId: string, focus = false): void {
    setChosen(slotId);
    const tab = tablist?.querySelector<HTMLElement>(`#${CSS.escape(cellTabId(slotId))}`);
    // Optional: not every environment implements scrollIntoView.
    (tab?.scrollIntoView as ((options: ScrollIntoViewOptions) => void) | undefined)?.call(tab, {
      inline: 'nearest',
      block: 'nearest',
    });
    if (focus) tab?.focus();
  }
  function step(delta: number, focus = false): void {
    const list = ids();
    const current = activeId();
    if (current === undefined) return;
    const next = list[list.indexOf(current) + delta];
    if (next !== undefined) activate(next, focus);
  }
  function onTabKeyDown(event: KeyboardEvent): void {
    const list = ids();
    const first = list[0];
    const last = list[list.length - 1];
    if (event.key === 'ArrowRight') step(1, true);
    else if (event.key === 'ArrowLeft') step(-1, true);
    else if (event.key === 'Home' && first !== undefined) activate(first, true);
    else if (event.key === 'End' && last !== undefined) activate(last, true);
    else return;
    event.preventDefault();
  }

  let swipeStart: { x: number; y: number; pointerId: number } | undefined;
  function onSwipeStart(event: PointerEvent): void {
    swipeStart = undefined;
    if (!single() || !event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest(SWIPE_IGNORED)) return;
    swipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  }
  function onSwipeEnd(event: PointerEvent): void {
    const start = swipeStart;
    swipeStart = undefined;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    step(dx < 0 ? 1 : -1);
  }

  // Drag to reorder. The listeners are on the window because moving a cell in
  // the document releases any pointer capture its handle holds.
  const [dragging, setDragging] = createSignal<string>();
  const [announcement, setAnnouncement] = createSignal('');
  let lastTarget: string | undefined;

  function move(slotId: string, toIndex: number): void {
    props.onMove(slotId, toIndex);
    setAnnouncement(
      t('wall.cell.moved', { label: labelOf(slotId), position: toIndex + 1, count: ids().length }),
    );
  }

  function onDragMove(event: PointerEvent): void {
    const slotId = dragging();
    if (slotId === undefined) return;
    // Optional: not every environment implements elementFromPoint.
    const hit = (
      document.elementFromPoint as ((x: number, y: number) => Element | null) | undefined
    )?.call(document, event.clientX, event.clientY);
    const over = hit?.closest<HTMLElement>('[data-slot-id]')?.dataset.slotId;
    if (over === undefined || over === slotId) {
      lastTarget = undefined;
      return;
    }
    // After a swap the pointer can still be over the same neighbour; wait
    // until it has left before swapping with it again.
    if (over === lastTarget) return;
    lastTarget = over;
    const toIndex = ids().indexOf(over);
    if (toIndex !== -1) move(slotId, toIndex);
  }

  function endDrag(): void {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    setDragging(undefined);
  }
  onCleanup(endDrag);

  function startDrag(slotId: string, event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    endDrag();
    lastTarget = undefined;
    setDragging(slotId);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  // A cell that is alone on screen cannot be dragged.
  createEffect(
    on(shownAlone, (alone) => {
      if (alone !== undefined) endDrag();
    }),
  );

  return (
    <div class="wall-grid-area">
      <Show when={single() && ids().length > 0}>
        <div ref={tablist} class="wall-tabs" role="tablist" aria-label={t('wall.tabs.label')}>
          <For each={ids()}>
            {(slotId) => (
              <button
                type="button"
                role="tab"
                class="wall-tab"
                id={cellTabId(slotId)}
                aria-selected={slotId === activeId()}
                aria-controls={cellPanelId(slotId)}
                tabIndex={slotId === activeId() ? 0 : -1}
                onClick={() => activate(slotId)}
                onKeyDown={onTabKeyDown}
              >
                {labelOf(slotId)}
              </button>
            )}
          </For>
        </div>
        <div class="wall-dots" role="group" aria-label={t('wall.dots.label')}>
          <For each={ids()}>
            {(slotId) => {
              const phase = () => slotPhase(snapshotOf(slotId));
              return (
                <button
                  type="button"
                  class="wall-dot-button"
                  aria-current={slotId === activeId() ? 'true' : undefined}
                  aria-label={t('wall.dots.item', {
                    label: labelOf(slotId),
                    status: t(`wall.phase.${phase()}`),
                  })}
                  onClick={() => activate(slotId)}
                >
                  <span class="wall-dot" data-phase={phase()} />
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <div
        class="wall-grid"
        classList={{
          'wall-grid-single': shownAlone() !== undefined,
          'wall-grid-dragging': dragging() !== undefined,
        }}
        style={{
          'grid-template-columns':
            shownAlone() === undefined ? gridTemplateColumns(props.layout) : 'minmax(0, 1fr)',
        }}
        data-testid="wall-grid"
        onPointerDown={onSwipeStart}
        onPointerUp={onSwipeEnd}
        onPointerCancel={() => (swipeStart = undefined)}
      >
        <For each={ids()}>
          {(slotId) => {
            const slot = createMemo(() => slotOf(slotId));
            const position = createMemo(() =>
              props.ask ? queuePosition(props.ask, slotId) : undefined,
            );
            return (
              <Show when={slot()}>
                {(current) => (
                  <Cell
                    slot={current()}
                    snapshot={snapshotOf(slotId)}
                    queuePosition={position()}
                    index={ids().indexOf(slotId)}
                    count={ids().length}
                    readOnly={props.readOnly}
                    hidden={shownAlone() !== undefined && shownAlone() !== slotId}
                    maximised={!single() && props.maximised === slotId}
                    single={single()}
                    dragging={dragging() === slotId}
                    now={props.now}
                    onChange={(change) => props.onChange(slotId, change)}
                    onRemove={() => props.onRemove(slotId)}
                    onDuplicate={() => props.onDuplicate(slotId)}
                    onToggleMaximise={() =>
                      props.onMaximise(props.maximised === slotId ? null : slotId)
                    }
                    onCancel={() => props.onCancel(slotId)}
                    onMove={(toIndex) => move(slotId, toIndex)}
                    onDragStart={(event) => startDrag(slotId, event)}
                  />
                )}
              </Show>
            );
          }}
        </For>
      </div>
      <p class="wall-visually-hidden" aria-live="polite">
        {announcement()}
      </p>
    </div>
  );
};
