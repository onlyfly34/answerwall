import { createEffect, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { Component, ParentComponent } from 'solid-js';
import { Route, Router, useLocation, useNavigate } from '@solidjs/router';
import { ROUTES } from '../contracts/routes.ts';
import { ProvidersPage } from '../pages/providers/ProvidersPage.tsx';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { SignInPage } from '../pages/sign-in/SignInPage.tsx';
import { HistoryPage, WallPage } from '../wall/index.tsx';
import { Layout } from './Layout.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { useShell } from './shell-context.ts';
import { StatusScreen } from './StatusScreen.tsx';
import { Toasts } from './Toasts.tsx';

/** The server's version is asked again when the page returns to the foreground, at most this often. */
const VERSION_CHECK_INTERVAL_MS = 60_000;

/** Pages exist only while settings and providers are loaded, as the services contract promises. */
function whenReady(Page: Component): Component {
  return () => {
    const { shell } = useShell();
    return (
      <Show when={shell.phase() === 'ready'}>
        <Page />
      </Show>
    );
  };
}

const SignInRoute: Component = () => {
  const { shell } = useShell();
  return (
    <Show when={shell.phase() === 'signed-out'}>
      <SignInPage onSignedIn={() => shell.signedIn()} />
    </Show>
  );
};

const SettingsRoute: Component = () => {
  const { shell } = useShell();
  return <SettingsPage onLogout={() => shell.logout()} onSignedOut={() => shell.signedOut()} />;
};

/** Decides what the current phase shows, and keeps the address in step with the session. */
const Root: ParentComponent = (props) => {
  const { shell } = useShell();
  const location = useLocation();
  const navigate = useNavigate();
  let returnTo: string = ROUTES.wall;

  createEffect(() => {
    const phase = shell.phase();
    const path = location.pathname;
    if (phase === 'signed-out' && path !== ROUTES.signIn) {
      returnTo = `${path}${location.search}`;
      navigate(ROUTES.signIn, { replace: true });
    } else if (phase === 'ready' && path === ROUTES.signIn) {
      navigate(returnTo, { replace: true });
      returnTo = ROUTES.wall;
    }
  });

  return (
    <>
      <Switch fallback={<StatusScreen />}>
        <Match when={shell.phase() === 'ready'}>
          <Layout>{props.children}</Layout>
        </Match>
        <Match when={shell.phase() === 'signed-out'}>{props.children}</Match>
      </Switch>
      <Toasts />
    </>
  );
};

export const App: Component = () => {
  const { shell } = useShell();

  onMount(() => {
    void shell.start();
    let lastCheck = Date.now();
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck < VERSION_CHECK_INTERVAL_MS) return;
      lastCheck = Date.now();
      void shell.checkVersion();
    };
    // An installed app opened without a network starts from its cache; it loads once there is one.
    const onOnline = (): void => {
      if (shell.phase() === 'unreachable') void shell.start();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
    });
  });

  return (
    <Router root={Root}>
      <Route path={ROUTES.signIn} component={SignInRoute} />
      <Route path={ROUTES.wall} component={whenReady(WallPage)} />
      <Route path={ROUTES.history} component={whenReady(HistoryPage)} />
      <Route path={ROUTES.providers} component={whenReady(ProvidersPage)} />
      <Route path={ROUTES.settings} component={whenReady(SettingsRoute)} />
      <Route path="*" component={whenReady(NotFoundPage)} />
    </Router>
  );
};
