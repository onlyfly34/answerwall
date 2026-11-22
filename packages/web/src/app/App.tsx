import { Show } from 'solid-js';
import type { Component } from 'solid-js';
import { useServices } from '../contracts/services.ts';
import { WallPage } from '../wall/index.tsx';

/** Scaffold shell: proves the page reaches the server and the wall mounts inside the services context. */
export const App: Component = () => {
  const { meta, i18n } = useServices();
  return (
    <main>
      <Show when={meta()} fallback={<p>{i18n.t('app.loading')}</p>}>
        {(loaded) => (
          <>
            <h1>{loaded().name}</h1>
            <p>{i18n.t('app.underConstruction', { version: loaded().version })}</p>
            <WallPage />
          </>
        )}
      </Show>
    </main>
  );
};
