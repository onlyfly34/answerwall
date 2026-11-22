/** Helpers shared by the wall's tests; nothing here is part of the application. */
import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router';
import { render } from '@solidjs/testing-library';
import type { Component, JSX } from 'solid-js';
import type { AskSnapshot, SlotSnapshot } from '@answerwall/core/protocol';
import { ROUTES } from '../contracts/routes.ts';
import { ServicesContext } from '../contracts/services.ts';
import { createFakeServices } from '../contracts/testing.ts';
import type { FakeServices } from '../contracts/testing.ts';
import { HistoryPage } from './HistoryPage.tsx';
import { WallPage } from './WallPage.tsx';

export function slotSnapshot(overrides: Partial<SlotSnapshot> = {}): SlotSnapshot {
  return {
    slotId: 's-1',
    providerId: 'claude',
    kind: 'claude',
    status: 'queued',
    text: '',
    reasoning: '',
    notices: [],
    truncated: false,
    ...overrides,
  };
}

export function askSnapshot(
  slots: SlotSnapshot[],
  overrides: Partial<AskSnapshot> = {},
): AskSnapshot {
  return {
    askId: 'ask-past',
    conversationId: 'conversation-past',
    prompt: 'What is a monad?',
    createdAt: Date.UTC(2026, 0, 15, 12, 0),
    status: 'done',
    seq: 10,
    slots,
    ...overrides,
  };
}

/** Renders a component with the fake services but without a router. */
export function renderWithServices(
  ui: () => JSX.Element,
  services: FakeServices = createFakeServices(),
): FakeServices {
  render(() => <ServicesContext.Provider value={services}>{ui()}</ServicesContext.Provider>);
  return services;
}

export interface MountedPages {
  services: FakeServices;
  history: ReturnType<typeof createMemoryHistory>;
}

/** Mounts the wall's two pages on their routes, as the shell does, at `url`. */
export function mountPages(
  url: string = ROUTES.wall,
  services: FakeServices = createFakeServices(),
): MountedPages {
  const history = createMemoryHistory();
  history.set({ value: url, replace: true });
  const Missing: Component = () => <p>no such page</p>;
  render(() => (
    <ServicesContext.Provider value={services}>
      <MemoryRouter history={history}>
        <Route path={ROUTES.wall} component={WallPage} />
        <Route path={ROUTES.history} component={HistoryPage} />
        <Route path="*" component={Missing} />
      </MemoryRouter>
    </ServicesContext.Provider>
  ));
  return { services, history };
}

export function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

/** Lets pending promise callbacks (API answers, router transitions) run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}
