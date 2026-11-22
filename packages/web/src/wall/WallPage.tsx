import { createEffect, createMemo, createSignal, on, onMount, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { DEFAULT_LAYOUT } from '@answerwall/core/protocol';
import type { AskSnapshot, AskTarget, ProviderStatus } from '@answerwall/core/protocol';
import { ROUTES } from '../contracts/routes.ts';
import { useServices } from '../contracts/services.ts';
import { Composer } from './components/Composer.tsx';
import { Icon } from './components/Icon.tsx';
import { LayoutControls } from './components/LayoutControls.tsx';
import { PresetBar } from './components/PresetBar.tsx';
import type { SlotChange } from './components/SlotPickers.tsx';
import { WallGrid } from './components/WallGrid.tsx';
import { effectiveLayout } from './state/layout.ts';
import { WALL_QUERY } from './navigation.ts';
import { createPresets } from './state/presets.ts';
import { canSendTo, defaultSlots } from './state/providers.ts';
import { copyTarget } from './state/slots.ts';
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

  function loadForAskingAgain(snapshot: AskSnapshot): void {
    state.setSlots(snapshot.slots.map(copyTarget));
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

  const anyActive = () =>
    shownAsk()?.slots.some((slot) => slot.status === 'queued' || slot.status === 'running') ??
    false;
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
    const status = shownAsk()?.slots.find((slot) => slot.slotId === slotId)?.status;
    return status === 'queued' || status === 'running';
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

  const connectionNotice = (): string | undefined => {
    const stream = asks.current();
    const shown = readOnly() ? viewed()?.askId : state.askId();
    if (!stream || stream.askId !== shown) return undefined;
    if (stream.connection() === 'reconnecting') return t('wall.connection.reconnecting');
    if (stream.connection() === 'failed') {
      return t('wall.connection.failed', { message: stream.error()?.message ?? '' });
    }
    return undefined;
  };

  return (
    <div class="wall" data-viewport={viewport()}>
      <h2 class="wall-visually-hidden">{t('wall.title')}</h2>
      <div class="wall-toolbar">
        <Show
          when={readOnly()}
          fallback={
            <PresetBar
              presets={presets}
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

      <Show when={connectionNotice()}>
        {(notice) => (
          <p class="wall-notice" role="status">
            {notice()}
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
