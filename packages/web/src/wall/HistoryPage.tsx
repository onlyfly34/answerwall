import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { HistoryItem } from '@answerwall/core/protocol';
import { useServices } from '../contracts/services.ts';
import { reaskHref, viewAskHref } from './navigation.ts';
import { SLOT_PHASES } from './state/slot-view.ts';
import type { SlotPhase } from './state/slot-view.ts';
import './wall.css';

/** Typing pauses this long before the list is searched. */
export const SEARCH_DEBOUNCE_MS = 300;
const QUERY_MAX_LENGTH = 200;

/** A list row carries the status only; `running` cannot be split into waiting and streaming. */
const phaseOfStatus = (status: HistoryItem['slots'][number]['status']): SlotPhase =>
  status === 'running' ? 'streaming' : (SLOT_PHASES.find((phase) => phase === status) ?? 'idle');

export const HistoryPage: Component = () => {
  const { api, asks, i18n, notify, providers } = useServices();
  const t = i18n.t;

  const [items, setItems] = createSignal<HistoryItem[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [applied, setApplied] = createSignal('');
  const [confirming, setConfirming] = createSignal<string>();
  const [deleting, setDeleting] = createSignal<string>();

  // Only the answer to the latest request may change the list.
  let requests = 0;
  async function load(cursor: string | null): Promise<void> {
    const request = ++requests;
    setLoading(true);
    setFailed(false);
    try {
      const page = await api.listHistory({
        ...(applied() === '' ? {} : { q: applied() }),
        ...(cursor === null ? {} : { cursor }),
      });
      if (request !== requests) return;
      setItems((previous) => (cursor === null ? page.items : [...previous, ...page.items]));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (request !== requests) return;
      setFailed(true);
      notify.reportError(error);
    } finally {
      if (request === requests) setLoading(false);
    }
  }

  let debounce: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(debounce));
  function applySearch(): void {
    clearTimeout(debounce);
    const next = search().trim();
    if (next === applied()) return;
    setApplied(next);
    void load(null);
  }
  function onSearchInput(value: string): void {
    setSearch(value);
    clearTimeout(debounce);
    debounce = setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
  }

  onMount(() => void load(null));

  async function remove(askId: string): Promise<void> {
    setDeleting(askId);
    try {
      await api.deleteHistoryEntry(askId);
      setItems((previous) => previous.filter((item) => item.askId !== askId));
      // The wall must not keep showing an ask that no longer exists.
      if (asks.current()?.askId === askId) asks.clear();
    } catch (error) {
      notify.reportError(error);
    } finally {
      setDeleting(undefined);
      setConfirming(undefined);
    }
  }

  const dateFormat = () =>
    new Intl.DateTimeFormat(i18n.language(), { dateStyle: 'medium', timeStyle: 'short' });
  const providerLabel = (providerId: string): string =>
    providers.providers().find((provider) => provider.instance.id === providerId)?.instance.label ??
    providerId;

  return (
    <div class="wall-history">
      <h2>{t('wall.history.title')}</h2>
      <form
        class="wall-inline-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          applySearch();
        }}
      >
        <label class="wall-field">
          <span>{t('wall.history.search')}</span>
          <input
            type="search"
            maxLength={QUERY_MAX_LENGTH}
            value={search()}
            onInput={(event) => onSearchInput(event.currentTarget.value)}
          />
        </label>
        <button type="submit" class="wall-button wall-button-small">
          {t('wall.history.searchButton')}
        </button>
      </form>

      <p class="wall-history-state" role="status">
        <Show when={loading()}>{t('wall.history.loading')}</Show>
        <Show when={!loading() && failed()}>{t('wall.history.failed')}</Show>
        <Show when={!loading() && !failed() && items().length === 0}>
          {t(applied() === '' ? 'wall.history.empty' : 'wall.history.noMatches')}
        </Show>
      </p>

      <ul class="wall-history-list">
        <For each={items()}>
          {(item) => (
            <li class="wall-history-item">
              <a class="wall-history-prompt" href={viewAskHref(item.askId)}>
                {item.promptPreview}
              </a>
              <div class="wall-history-meta">
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {dateFormat().format(item.createdAt)}
                </time>
                <ul class="wall-history-slots" aria-label={t('wall.history.cells')}>
                  <For each={item.slots}>
                    {(slot) => {
                      const phase = phaseOfStatus(slot.status);
                      return (
                        <li class="wall-history-slot">
                          <span class="wall-dot" data-phase={phase} aria-hidden="true" />
                          {providerLabel(slot.providerId)}
                          <Show when={slot.model}>{(model) => <span> {model()}</span>}</Show>
                          <span class="wall-visually-hidden"> {t(`wall.phase.${phase}`)}</span>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </div>
              <div class="wall-history-actions">
                <Show
                  when={confirming() === item.askId}
                  fallback={
                    <>
                      <a class="wall-button wall-button-small" href={viewAskHref(item.askId)}>
                        {t('wall.history.open')}
                      </a>
                      <a class="wall-button wall-button-small" href={reaskHref(item.askId)}>
                        {t('wall.history.askAgain')}
                      </a>
                      <button
                        type="button"
                        class="wall-button wall-button-small"
                        onClick={() => setConfirming(item.askId)}
                      >
                        {t('wall.delete')}
                      </button>
                    </>
                  }
                >
                  <span>{t('wall.history.confirmDelete')}</span>
                  <button
                    type="button"
                    class="wall-button wall-button-small wall-button-danger"
                    disabled={deleting() === item.askId}
                    onClick={() => void remove(item.askId)}
                  >
                    {t('wall.delete')}
                  </button>
                  <button
                    type="button"
                    class="wall-button wall-button-small"
                    onClick={() => setConfirming(undefined)}
                  >
                    {t('wall.cancel')}
                  </button>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>

      <Show when={nextCursor()}>
        {(cursor) => (
          <button
            type="button"
            class="wall-button"
            disabled={loading()}
            onClick={() => void load(cursor())}
          >
            {t('wall.history.more')}
          </button>
        )}
      </Show>
    </div>
  );
};
