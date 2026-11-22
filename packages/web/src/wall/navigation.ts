/** Addresses on the wall's route that the history links to. */
import { hrefOf, ROUTES } from '../contracts/routes.ts';

export const WALL_QUERY = {
  /** Shows this past ask read-only. */
  view: 'ask',
  /** Loads this past ask's cells and prompt into the wall, ready to send. */
  reask: 'reask',
} as const;

export const viewAskHref = (askId: string): string =>
  hrefOf(`${ROUTES.wall}?${WALL_QUERY.view}=${encodeURIComponent(askId)}`);

export const reaskHref = (askId: string): string =>
  hrefOf(`${ROUTES.wall}?${WALL_QUERY.reask}=${encodeURIComponent(askId)}`);
