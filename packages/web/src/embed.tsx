/**
 * The entry for a page that ships this UI itself and talks to a server on
 * another origin: the wall page of the browser extension (docs/web-cells.md).
 * The server's own page starts from `main.tsx` instead.
 */
// First: it configures the validation library before any module builds a schema.
import './infra/zod-config.ts';
import { mountApp } from './app/mount.tsx';
import { keepRoutesInFragment } from './contracts/routes.ts';
import { createRemoteConnection } from './infra/connection.ts';
import type { TokenStore } from './infra/connection.ts';
import { createServices } from './infra/services.ts';
import type { WebCellHost } from './contracts/services.ts';
import type { ShellServices } from './infra/services.ts';

export type { TokenStore } from './infra/connection.ts';
export type {
  WebCellConnection,
  WebCellFailureDetail,
  WebCellFrame,
  WebCellHost,
  WebCellRunOptions,
  WebCellRunResult,
  WebCellSite,
  WebCellStage,
} from './contracts/services.ts';

export interface EmbeddedOptions {
  root: HTMLElement;
  /** The origin of the AnswerWall server this page was paired with. */
  server: string;
  /** Where the device token is kept between page loads. */
  tokens: TokenStore;
  /** This page can frame the vendors' sites: the wall shows web cells through it. */
  webCells?: WebCellHost;
}

export interface EmbeddedApp {
  services: ShellServices;
  unmount(): void;
}

/**
 * Mounts the app against a server on another origin. Requests carry
 * `Authorization: Bearer` and never a cookie, routes live in the address's
 * fragment, and no service worker is registered.
 */
export function mountEmbedded(options: EmbeddedOptions): EmbeddedApp {
  // The page is one file: a plain link to a route must not leave it.
  keepRoutesInFragment();
  const connection = createRemoteConnection({ base: options.server, tokens: options.tokens });
  const services = createServices({
    connection,
    ...(options.webCells ? { webCells: options.webCells } : {}),
  });
  return { services, unmount: mountApp(options.root, services) };
}
