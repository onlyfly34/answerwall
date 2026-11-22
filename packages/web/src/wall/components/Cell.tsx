import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from 'solid-js';
import type { Accessor, Component } from 'solid-js';
import type { AskTarget, ProviderStatus, SlotSnapshot } from '@answerwall/core/protocol';
import { hrefOf, ROUTES } from '../../contracts/routes.ts';
import { useServices } from '../../contracts/services.ts';
import { copyText } from '../clipboard.ts';
import { COPIED_FEEDBACK_MS, Markdown } from '../markdown/Markdown.tsx';
import { effectiveModel, providerIssue } from '../state/providers.ts';
import { useWebCellRunner } from '../state/web-runner.ts';
import { formatDuration, isActivePhase, slotPhase } from '../state/slot-view.ts';
import { Icon } from './Icon.tsx';
import { SlotPickers } from './SlotPickers.tsx';
import type { SlotChange } from './SlotPickers.tsx';
import { WebCellFrame } from './WebCellFrame.tsx';

/** How close to the bottom (CSS px) still counts as "at the bottom". */
const STICK_THRESHOLD_PX = 24;

export const cellPanelId = (slotId: string): string => `wall-panel-${slotId}`;
export const cellTabId = (slotId: string): string => `wall-tab-${slotId}`;

export interface CellProps {
  slot: AskTarget;
  /** The slot's part of the ask on the wall, if it has one. */
  snapshot: SlotSnapshot | undefined;
  queuePosition: number | undefined;
  /** Zero-based place on the wall, and the number of cells. */
  index: number;
  count: number;
  /** A past ask: nothing can be rearranged or reconfigured. */
  readOnly: boolean;
  hidden: boolean;
  maximised: boolean;
  /** One cell at a time (phone): the cell is a tab panel and has no grid controls. */
  single: boolean;
  dragging: boolean;
  /** Wall-wide clock that ticks while an ask runs. */
  now: Accessor<number>;
  onChange(change: SlotChange): void;
  onRemove(): void;
  onDuplicate(): void;
  onToggleMaximise(): void;
  onCancel(): void;
  onMove(toIndex: number): void;
  onDragStart(event: PointerEvent): void;
}

export const Cell: Component<CellProps> = (props) => {
  const { i18n, providers, settings, webCells } = useServices();
  const t = i18n.t;
  const runner = useWebCellRunner();

  const status = createMemo((): ProviderStatus | undefined =>
    providers.providers().find((provider) => provider.instance.id === props.slot.providerId),
  );
  const label = () => status()?.instance.label ?? props.slot.providerId;
  const issue = () =>
    props.readOnly ? undefined : providerIssue(status(), webCells !== undefined);
  /**
   * The site this cell frames: a web provider, on a page that can frame it,
   * while the wall is live. A past ask shows the stored answer instead.
   */
  const framed = createMemo(() => {
    const instance = status()?.instance;
    return !props.readOnly && webCells && instance?.kind === 'web' && instance.enabled
      ? instance.site
      : undefined;
  });
  const phase = createMemo(() => slotPhase(props.snapshot));
  const active = () => isActivePhase(phase());

  // Elapsed time. The server's start time is on the server's clock, so a cell
  // that saw the slot start counts from that moment on its own clock.
  const [runningSince, setRunningSince] = createSignal<number>();
  let sawQueued = false;
  createEffect(() => {
    const slotStatus = props.snapshot?.status;
    if (slotStatus !== 'running') {
      sawQueued = slotStatus === 'queued';
      setRunningSince(undefined);
    } else if (untrack(runningSince) === undefined) {
      const now = Date.now();
      setRunningSince(sawQueued ? now : Math.min(props.snapshot?.startedAt ?? now, now));
    }
  });
  const elapsed = (): string | undefined => {
    const snapshot = props.snapshot;
    if (!snapshot) return undefined;
    if (snapshot.elapsedMs !== undefined) return formatDuration(snapshot.elapsedMs, true);
    const since = runningSince();
    return since === undefined ? undefined : formatDuration(props.now() - since, false);
  };

  /** What a framed cell says instead of the wording for a provider the server runs. */
  const webStatusText = (): string | undefined => {
    if (!framed()) return undefined;
    const note = runner?.note(props.slot.slotId);
    const current = phase();
    if (current === 'idle' || current === 'waiting' || current === 'streaming') {
      if (note?.kind === 'stage') return t(`wall.web.status.${note.stage}`);
      if (current !== 'idle') return t('wall.web.status.starting');
      if (note?.kind === 'sent') return t('wall.web.status.sent');
      if (note?.kind === 'failed') return t(`wall.web.failure.${note.detail}`);
      const switches = settings.settings()?.webCells;
      return switches?.fillPrompt === true || switches?.readAnswer === true
        ? undefined
        : t('wall.web.status.byHand');
    }
    return current === 'done' ? t('wall.web.status.stored') : undefined;
  };

  const statusText = (): string => {
    const web = webStatusText();
    if (web !== undefined) return web;
    const block = props.snapshot?.streaming === 'block';
    switch (phase()) {
      case 'idle':
        return t('wall.status.idle');
      case 'queued':
        return props.queuePosition === undefined
          ? t('wall.status.queued')
          : t('wall.status.queuedAt', { position: props.queuePosition });
      case 'waiting':
        return block ? t('wall.status.block') : t('wall.status.waiting');
      case 'streaming':
        return block ? t('wall.status.block') : t('wall.status.streaming');
      case 'done':
        return t('wall.status.done');
      case 'error':
        return t('wall.status.error');
      case 'cancelled':
        return t('wall.status.cancelled');
      case 'timeout':
        return t('wall.status.timeout');
    }
  };

  const usage = (): string | undefined => {
    const value = props.snapshot?.usage;
    if (!value) return undefined;
    const parts = [
      value.inputTokens !== undefined && t('wall.usage.input', { count: value.inputTokens }),
      value.outputTokens !== undefined && t('wall.usage.output', { count: value.outputTokens }),
      value.reasoningTokens !== undefined &&
        t('wall.usage.reasoning', { count: value.reasoningTokens }),
    ].filter((part): part is string => part !== false);
    return parts.length > 0 ? parts.join(' · ') : undefined;
  };

  const answeredWith = (): string | undefined => {
    const snapshot = props.snapshot;
    if (!snapshot?.model) return undefined;
    return snapshot.effort ? `${snapshot.model} · ${snapshot.effort}` : snapshot.model;
  };

  // Auto-scroll: follow the answer until the reader scrolls away from the bottom.
  let body!: HTMLDivElement;
  let stick = true;
  const onScroll = (): void => {
    stick = body.scrollHeight - body.scrollTop - body.clientHeight <= STICK_THRESHOLD_PX;
  };
  const followOutput = (): void => {
    if (stick) body.scrollTop = body.scrollHeight;
  };
  createEffect(
    on(phase, (current) => {
      if (current === 'queued') stick = true;
    }),
  );

  const [reasoningOpen, setReasoningOpen] = createSignal(false);

  const [copyState, setCopyState] = createSignal<'idle' | 'copied' | 'failed'>('idle');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyTimer));
  async function copyAnswer(): Promise<void> {
    const copied = await copyText(props.snapshot?.text ?? '');
    setCopyState(copied ? 'copied' : 'failed');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopyState('idle'), COPIED_FEEDBACK_MS);
  }

  let handle: HTMLButtonElement | undefined;
  function onHandleKeyDown(event: KeyboardEvent): void {
    const target = {
      ArrowLeft: props.index - 1,
      ArrowUp: props.index - 1,
      ArrowRight: props.index + 1,
      ArrowDown: props.index + 1,
      Home: 0,
      End: props.count - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    if (target < 0 || target >= props.count || target === props.index) return;
    props.onMove(target);
    // Moving the cell in the document drops the focus; the handle keeps it.
    queueMicrotask(() => handle?.focus());
  }

  return (
    <article
      class="wall-cell"
      classList={{ 'wall-cell-dragging': props.dragging, 'wall-cell-maximised': props.maximised }}
      id={cellPanelId(props.slot.slotId)}
      role={props.single ? 'tabpanel' : undefined}
      aria-labelledby={props.single ? cellTabId(props.slot.slotId) : undefined}
      aria-label={props.single ? undefined : label()}
      data-slot-id={props.slot.slotId}
      data-phase={phase()}
      data-web={framed() ? 'frame' : undefined}
      hidden={props.hidden}
    >
      <header class="wall-cell-header">
        <div class="wall-cell-title">
          <Show when={!props.readOnly && !props.single}>
            <button
              ref={handle}
              type="button"
              class="wall-icon-button wall-cell-handle"
              aria-label={t('wall.cell.move', {
                label: label(),
                position: props.index + 1,
                count: props.count,
              })}
              title={t('wall.cell.moveHint')}
              onPointerDown={(event) => props.onDragStart(event)}
              onKeyDown={onHandleKeyDown}
            >
              <Icon name="grip" />
            </button>
          </Show>
          <h3 class="wall-cell-name">{label()}</h3>
          <Show when={props.readOnly ? answeredWith() : effectiveModel(status(), props.slot)}>
            {(model) => <span class="wall-cell-model">{model()}</span>}
          </Show>
          <span class="wall-cell-actions">
            <Show when={!props.readOnly}>
              <button
                type="button"
                class="wall-icon-button"
                aria-label={t('wall.cell.duplicate', { label: label() })}
                title={t('wall.cell.duplicate', { label: label() })}
                onClick={() => props.onDuplicate()}
              >
                <Icon name="duplicate" />
              </button>
            </Show>
            <Show when={!props.single}>
              <button
                type="button"
                class="wall-icon-button"
                aria-pressed={props.maximised}
                aria-label={t(props.maximised ? 'wall.cell.restore' : 'wall.cell.maximise', {
                  label: label(),
                })}
                title={t(props.maximised ? 'wall.cell.restore' : 'wall.cell.maximise', {
                  label: label(),
                })}
                onClick={() => props.onToggleMaximise()}
              >
                <Icon name={props.maximised ? 'restore' : 'maximise'} />
              </button>
            </Show>
            <Show when={!props.readOnly}>
              <button
                type="button"
                class="wall-icon-button"
                aria-label={t('wall.cell.remove', { label: label() })}
                title={t('wall.cell.remove', { label: label() })}
                onClick={() => props.onRemove()}
              >
                <Icon name="close" />
              </button>
            </Show>
          </span>
        </div>
        <Show when={!props.readOnly}>
          <SlotPickers slot={props.slot} status={status()} onChange={(c) => props.onChange(c)} />
        </Show>
        <Show when={issue()}>
          {(current) => (
            <p class="wall-cell-issue">
              {t(`wall.issue.notice.${current()}`)}{' '}
              <Show when={status()?.detection?.hint}>{(hint) => <span>{hint()} </span>}</Show>
              <a href={hrefOf(ROUTES.providers)}>{t('wall.issue.openProviders')}</a>
            </p>
          )}
        </Show>
      </header>

      <div class="wall-cell-statusbar">
        <span class="wall-dot" data-phase={phase()} aria-hidden="true" />
        <span class="wall-cell-status" role="status">
          {statusText()}
        </span>
        <Show when={!props.readOnly && props.snapshot && answeredWith()}>
          {(model) => <span class="wall-cell-meta">{model()}</span>}
        </Show>
        <Show when={elapsed()}>
          {(time) => (
            <span class="wall-cell-meta" data-testid="elapsed">
              {time()}
            </span>
          )}
        </Show>
        <Show when={usage()}>
          {(tokens) => (
            <span class="wall-cell-meta" data-testid="usage">
              {tokens()}
            </span>
          )}
        </Show>
        <Show when={active()}>
          <button
            type="button"
            class="wall-button wall-button-small wall-cell-cancel"
            aria-label={t('wall.cell.cancel', { label: label() })}
            onClick={() => props.onCancel()}
          >
            <Icon name="stop" />
            {t('wall.cancel')}
          </button>
        </Show>
      </div>

      <div ref={body} class="wall-cell-body" onScroll={onScroll}>
        <Show when={props.snapshot?.error}>
          {(error) => (
            <div class="wall-cell-error" role="alert">
              <strong>{t(`wall.error.${error().code}`)}</strong>
              <Show when={error().message}>
                <p>{error().message}</p>
              </Show>
            </div>
          )}
        </Show>
        <Show when={props.snapshot?.truncated}>
          <p class="wall-cell-flag">{t('wall.cell.truncated')}</p>
        </Show>
        <For each={props.snapshot?.notices.filter((notice) => notice.code === 'provider')}>
          {(notice) => <p class="wall-cell-notice">{notice.message}</p>}
        </For>
        <Show when={props.snapshot?.reasoning}>
          <details
            class="wall-reasoning"
            onToggle={(event) => setReasoningOpen(event.currentTarget.open)}
          >
            <summary>{t('wall.cell.reasoning')}</summary>
            <Show when={reasoningOpen()}>
              <pre class="wall-reasoning-text">{props.snapshot?.reasoning}</pre>
            </Show>
          </details>
        </Show>
        {/* A framed cell shows the site's own page; its stored answer is in history. */}
        <Show when={!framed()}>
          <Markdown
            text={props.snapshot?.text ?? ''}
            final={!active()}
            visible={!props.hidden}
            onRendered={followOutput}
          />
        </Show>
      </div>

      {/* Keyed by the site alone: the frame survives every other change to the provider. */}
      <Show when={webCells && framed()} keyed>
        {(site) => (
          <Show when={webCells}>
            {(host) => (
              <WebCellFrame slotId={props.slot.slotId} site={site} label={label()} host={host()} />
            )}
          </Show>
        )}
      </Show>

      <Show when={props.snapshot?.text}>
        <footer class="wall-cell-footer">
          <button
            type="button"
            class="wall-button wall-button-small"
            aria-label={t('wall.cell.copyAnswer', { label: label() })}
            onClick={() => void copyAnswer()}
          >
            <Icon name="copy" />
            {t(
              copyState() === 'copied'
                ? 'wall.copied'
                : copyState() === 'failed'
                  ? 'wall.copyFailed'
                  : 'wall.cell.copy',
            )}
          </button>
        </footer>
      </Show>
    </article>
  );
};
