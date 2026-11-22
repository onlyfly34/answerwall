/** The wall's public surface: the two pages the app shell mounts. */
import type { Component } from 'solid-js';
import { useServices } from '../contracts/services.ts';

export const WallPage: Component = () => {
  const { i18n } = useServices();
  return <p>{i18n.t('wall.placeholder')}</p>;
};

export const HistoryPage: Component = () => {
  const { i18n } = useServices();
  return <p>{i18n.t('wall.historyPlaceholder')}</p>;
};
