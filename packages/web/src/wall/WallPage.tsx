import { createEffect, createMemo, createSignal, on, onMount, Show, untrack } from 'solid-js';
import type { Component } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { DEFAULT_LAYOUT } from '@answerwall/core/protocol';
import type { AskSnapshot, AskTarget, ProviderStatus } from '@answerwall/core/protocol';
import { ROUTES } from '../contracts/routes.ts';
import { ApiError, useServices } from '../contracts/services.ts';
import type { AskStream } from '../contracts/services.ts';
import { Composer } from './components/Composer.tsx';
import { Icon } from './components/Icon.tsx';
import { LayoutControls } from './components/LayoutControls.tsx';
import { PresetBar } from './components/PresetBar.tsx';
import type { SlotChange } from './components/SlotPickers.tsx';
import { WallGrid } from './components/WallGrid.tsx';
import { effectiveLayout } from './state/layout.ts';
import { WALL_QUERY } from './navigation.ts';
import { createPresets } from './state/presets.ts';
import type { Presets } from './state/presets.ts';
import { canSendTo, defaultSlots } from './state/providers.ts';
import { copyTarget, isUnfinished, showsSlot } from './state/slots.ts';
import { utf8Bytes } from './state/slot-view.ts';
import { createTicker } from './state/ticker.ts';
import { createViewport } from './state/viewport.ts';
import { createWallState } from './state/wall-state.ts';
import './wall.css';

type Viewed =
  | { askId: string; state: 'loading' | 'failed' }
  | { askId: string; state: 'ready'; snapshot: AskSnapshot };

const single = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value) || undefined;

export const WallPage: Component = () => {
  const services = useServices();
  const { api, asks, i18n, notify, providers, settings } = services;
  const t = i18n.t;
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const viewport = createViewport();
  const state = createWallState(() => defaultSlots(providers.providers()));
  const presets = createPresets(services, state);
  /** The presets as the bar uses them: switching the wall first stops what would go unseen. */
  const shownPresets: Presets = {
    ...presets,
    apply(preset) {
      cancelUnshown(preset.slots);
      presets.apply(preset);
    },
  };

  const providerOf = (slot: AskTarget): ProviderStatus | undefined =>
    providers.providers().find((provider) => provider.instance.id === slot.providerId);

  // A past ask shown read-only.
  const viewedId = () => single(query[WALL_QUERY.view]);
  const [viewed, setViewed] = createSignal<Viewed>();
  createEffect(
    on(viewedId, (askId) => {
      if (askId === undefined) {
        setViewed(undefined);
        return;
      }
      setViewed({ askId, state: 'loading' });
      api.getHistoryEntry(askId).then(
        (snapshot) => {
          if (viewedId() !== askId) return;
          // An ask that is still running is followed live.
          if (snapshot.status === 'running' && asks.current()?.askId !== askId) asks.follow(askId);
          setViewed({ askId, state: 'ready', snapshot });
        },
        (error: unknown) => {
          if (viewedId() !== askId) return;
          setViewed({ askId, state: 'failed' });
          notify.reportError(error);
        },
      );
    }),
  );

  /** The ask whose answers are on screen: the viewed one, else the one sent from this wall. */
  const shownAsk = createMemo((): AskSnapshot | undefined => {
    const view = viewed();
    const live = asks.current();
    if (!view) return live?.askId === state.askId() ? live.snapshot() : undefined;
    if (view.state !== 'ready') return undefined;
    return (live?.askId === view.askId ? live.snapshot() : undefined) ?? view.snapshot;
  });
  const readOnly = () => viewed() !== undefined;
  // The maximised cell of a past ask is not part of the wall's own arrangement.
  const [viewMaximised, setViewMaximised] = createSignal<string | null>(null);
  createEffect(on(viewedId, () => setViewMaximised(null), { defer: true }));
  const slots = createMemo((): readonly AskTarget[] =>
    readOnly() ? (shownAsk()?.slots.map(copyTarget) ?? []) : state.slots,
  );

  onMount(() => void presets.load());
  // After a reload, or on the way back from a past ask, pick this wall's ask up again.
  createEffect(
    on(viewedId, (viewedAskId) => {
      const askId = state.askId();
      if (viewedAskId === undefined && askId !== null && asks.current()?.askId !== askId) {
        asks.follow(askId);
      }
    }),
  );
  // An ask that cannot be followed at all (it no longer exists) is forgotten.
  // One that fails later keeps what it received on the wall, with a notice.
  createEffect(() => {
    const stream = asks.current();
    if (stream?.connection() !== 'failed' || stream.askId !== state.askId()) return;
    if (stream.snapshot() !== undefined) return;
    state.setAskId(null);
    asks.clear();
  });
  // An ask whose submission outlived the wall that sent it (the user went to
  // another page before the server answered) belongs to this wall: it went to
  // these cells and its prompt is still the draft.
  createEffect(() => {
    if (state.askId() !== null || viewedId() !== undefined) return;
    const stream = asks.current();
    const snapshot = stream?.snapshot();
    if (!stream || !snapshot) return;
    if (!snapshot.slots.some((slot) => showsSlot(state.slots, slot))) return;
    if (untrack(state.prompt) !== snapshot.prompt) return;
    state.setAskId(stream.askId);
    state.setPrompt('');
  });

  /**
   * Called before the wall's cells are replaced as a whole: cancels what the
   * wall's own ask is still doing in cells the next arrangement does not
   * show, so that nothing keeps running unseen.
   */
  function cancelUnshown(next: readonly AskTarget[]): void {
    const askId = state.askId();
    if (askId === null) return;
    const stream = asks.current();
    const snapshot = stream?.askId === askId ? stream.snapshot() : undefined;
    let slotIds: (string | undefined)[];
    if (snapshot) {
      const unfinished = snapshot.slots.filter(isUnfinished);
      const unshown = unfinished.filter((slot) => !showsSlot(next, slot));
      slotIds =
        unshown.length > 0 && unshown.length === unfinished.length
          ? [undefined]
          : unshown.map((slot) => slot.slotId);
    } else {
      // The ask is not being followed (a past ask is on screen), so which of
      // its slots still run is unknown: unless every cell stays, cancel it whole.
      slotIds = state.slots.every((cell) => showsSlot(next, cell)) ? [] : [undefined];
    }
    for (const slotId of slotIds) {
      api.cancelAsk(askId, slotId).catch((error: unknown) => {
        // An ask that is gone has nothing left to cancel.
        if (!(error instanceof ApiError && error.code === 'not_found')) notify.reportError(error);
      });
    }
  }

  function loadForAskingAgain(snapshot: AskSnapshot): void {
    const next = snapshot.slots.map(copyTarget);
    cancelUnshown(next);
    // A past ask that was followed live while it was on screen is left behind.
    if (asks.current() && asks.current()?.askId !== state.askId()) asks.clear();
    state.setSlots(next);
    state.setPresetId(null);
    state.setPrompt(snapshot.prompt);
    notify.toast({ kind: 'info', message: t('wall.reask.loaded') });
  }
  createEffect(
    on(
      () => single(query[WALL_QUERY.reask]),
      (askId) => {
        if (askId === undefined) return;
        // The parameter is consumed, so a reload does not overwrite the wall again.
        api
          .getHistoryEntry(askId)
          .then(loadForAskingAgain, (error: unknown) => notify.reportError(error))
          .finally(() => navigate(ROUTES.wall, { replace: true }));
      },
    ),
  );

  const anyActive = () => shownAsk()?.slots.some(isUnfinished) ?? false;
  /** The wall's ask is known by its id only (after a reload): its state is on its way. */
  const loadingAsk = () => {
    const stream = asks.current();
    return (
      stream !== undefined &&
      stream.askId === state.askId() &&
      stream.snapshot() === undefined &&
      stream.connection() !== 'failed'
    );
  };
  const now = createTicker(anyActive);

  const layout = () =>
    effectiveLayout(state.layout(), settings.settings()?.layout ?? DEFAULT_LAYOUT, viewport());

  // Sending.
  const [sending, setSending] = createSignal(false);
  const sendable = createMemo(() => state.slots.filter((slot) => canSendTo(providerOf(slot))));
  const promptBytes = createMemo(() => utf8Bytes(state.prompt()));
  const maxPromptBytes = () =>
    settings.settings()?.limits.maxPromptBytes ?? Number.MAX_SAFE_INTEGER;
  const blocked = (): string | undefined => {
    const maxTargets = settings.settings()?.limits.maxTargetsPerAsk ?? Number.MAX_SAFE_INTEGER;
    if (state.slots.length === 0) return t('wall.composer.noCells');
    if (sendable().length === 0) return t('wall.composer.noneAvailable');
    if (sendable().length > maxTargets) {
      return t('wall.composer.tooManyCells', { count: sendable().length, limit: maxTargets });
    }
    if (anyActive()) return t('wall.composer.running');
    // Until the ask is known, it may well have unfinished cells.
    if (loadingAsk()) return t('wall.composer.loading');
    if (state.prompt().trim() === '') return t('wall.composer.empty');
    if (promptBytes() > maxPromptBytes()) return t('wall.composer.tooLong');
    return undefined;
  };

  async function send(): Promise<void> {
    if (blocked() !== undefined || sending()) return;
    setSending(true);
    try {
      const stream = await asks.submit({
        prompt: state.prompt(),
        targets: sendable().map(copyTarget),
      });
      state.setAskId(stream.askId);
      state.setPrompt('');
    } catch (error) {
      // The prompt stays in the composer.
      notify.reportError(error);
    } finally {
      setSending(false);
    }
  }

  function cancel(slotId?: string): void {
    asks.cancel(slotId).catch((error: unknown) => notify.reportError(error));
  }

  function isActiveSlot(slotId: string): boolean {
    const slot = shownAsk()?.slots.find((candidate) => candidate.slotId === slotId);
    return slot !== undefined && isUnfinished(slot);
  }

  function addCell(): void {
    const last = state.slots[state.slots.length - 1];
    const provider =
      (last && canSendTo(providerOf(last)) ? providerOf(last) : undefined) ??
      providers.providers().find(canSendTo);
    if (provider) state.addSlot(provider.instance.id);
  }

  function duplicate(slotId: string): void {
    const slot = state.slots.find((candidate) => candidate.slotId === slotId);
    if (slot) state.addSlot(slot.providerId, slot.model, slot.effort, slotId);
  }

  function change(slotId: string, next: SlotChange): void {
    const slot = state.slots.find((candidate) => candidate.slotId === slotId);
    // The cell stops showing another provider's answer, which must not keep running unseen.
    if (next.providerId !== undefined && next.providerId !== slot?.providerId) {
      if (isActiveSlot(slotId)) cancel(slotId);
    }
    state.updateSlot(slotId, next);
  }

  function remove(slotId: string): void {
    // A removed cell would otherwise keep running unseen.
    if (isActiveSlot(slotId)) cancel(slotId);
    state.removeSlot(slotId);
  }

  /** The stream of the ask on screen, while its connection needs the user's attention. */
  const troubledStream = (): AskStream | undefined => {
    const stream = asks.current();
    const shown = readOnly() ? viewed()?.askId : state.askId();
    if (!stream || stream.askId !== shown) return undefined;
    const connection = stream.connection();
    return connection === 'reconnecting' || connection === 'failed' ? stream : undefined;
  };

  return (
    <div class="wall" data-viewport={viewport()}>
      <h2 class="wall-visually-hidden">{t('wall.title')}</h2>
      <div class="wall-toolbar">
        <Show
          when={readOnly()}
          fallback={
            <PresetBar
              presets={shownPresets}
              defaultPresetId={state.defaultPresetId()}
              canSave={state.slots.length > 0}
            />
          }
        >
          <div class="wall-view-banner" role="status">
            <span>
              <Show
                when={shownAsk()}
                fallback={t(
                  viewed()?.state === 'failed' ? 'wall.view.failed' : 'wall.view.loading',
                )}
              >
                {(ask) =>
                  t('wall.view.banner', {
                    date: new Intl.DateTimeFormat(i18n.language(), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(ask().createdAt),
                  })
                }
              </Show>
            </span>
            <Show when={shownAsk()}>
              {(ask) => (
                <button
                  type="button"
                  class="wall-button wall-button-small wall-button-primary"
                  onClick={() => {
                    loadForAskingAgain(ask());
                    navigate(ROUTES.wall);
                  }}
                >
                  {t('wall.view.askAgain')}
                </button>
              )}
            </Show>
            <Show when={anyActive()}>
              <button type="button" class="wall-button wall-button-small" onClick={() => cancel()}>
                <Icon name="stop" />
                {t('wall.composer.cancelAll')}
              </button>
            </Show>
            <a class="wall-button wall-button-small" href={ROUTES.history}>
              {t('wall.view.backToHistory')}
            </a>
            <a class="wall-button wall-button-small" href={ROUTES.wall}>
              {t('wall.view.backToWall')}
            </a>
          </div>
        </Show>
        <Show when={viewport() !== 'phone'}>
          <LayoutControls
            layout={layout()}
            customised={state.layout() !== null}
            onChange={(next) => state.setLayout(next)}
            onReset={() => state.setLayout(null)}
          />
        </Show>
        <Show when={!readOnly()}>
          <button
            type="button"
            class="wall-button wall-button-small"
            disabled={!providers.providers().some(canSendTo)}
            onClick={addCell}
          >
            <Icon name="add" />
            {t('wall.addCell')}
          </button>
        </Show>
      </div>

      <Show when={troubledStream()}>
        {(stream) => (
          <p class="wall-notice" role="status">
            <Show
              when={stream().connection() === 'failed'}
              fallback={t('wall.connection.reconnecting')}
            >
              <span>{t('wall.connection.failed')}</span>{' '}
              {/* A stream that gave up never resumes by itself; following again loads the ask afresh. */}
              <button
                type="button"
                class="wall-button wall-button-small"
                onClick={() => asks.follow(stream().askId)}
              >
                {t('wall.connection.retry')}
              </button>
            </Show>
          </p>
        )}
      </Show>

      <Show when={shownAsk()}>
        {(ask) => (
          <details class="wall-asked" open={readOnly()}>
            <summary>{t('wall.asked')}</summary>
            <pre class="wall-asked-text">{ask().prompt}</pre>
          </details>
        )}
      </Show>

      <Show when={!readOnly() && state.slots.length === 0}>
        <p class="wall-empty">
          {t('wall.empty')}{' '}
          <Show when={!providers.providers().some(canSendTo)}>
            <a href={ROUTES.providers}>{t('wall.issue.openProviders')}</a>
          </Show>
        </p>
      </Show>

      <WallGrid
        slots={slots()}
        ask={shownAsk()}
        layout={layout()}
        viewport={viewport()}
        maximised={readOnly() ? viewMaximised() : state.maximised()}
        readOnly={readOnly()}
        now={now}
        onChange={change}
        onRemove={remove}
        onDuplicate={duplicate}
        onMaximise={(slotId) =>
          readOnly() ? setViewMaximised(slotId) : state.setMaximised(slotId)
        }
        onCancel={cancel}
        onMove={(slotId, toIndex) => state.moveSlot(slotId, toIndex)}
      />

      <Show when={!readOnly()}>
        <Composer
          prompt={state.prompt()}
          promptBytes={promptBytes()}
          maxPromptBytes={maxPromptBytes()}
          targetCount={sendable().length}
          blocked={blocked()}
          sending={sending()}
          running={anyActive()}
          onInput={(prompt) => state.setPrompt(prompt)}
          onSend={() => void send()}
          onCancelAll={() => cancel()}
        />
      </Show>
    </div>
  );
};
