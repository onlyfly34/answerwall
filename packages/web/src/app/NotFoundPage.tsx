import type { Component } from 'solid-js';
import { A } from '@solidjs/router';
import { ROUTES } from '../contracts/routes.ts';
import { useServices } from '../contracts/services.ts';

export const NotFoundPage: Component = () => {
  const { i18n } = useServices();
  return (
    <div class="app-page">
      <h1>{i18n.t('app.notFound.title')}</h1>
      <p>
        <A href={ROUTES.wall}>{i18n.t('app.notFound.back')}</A>
      </p>
    </div>
  );
};
