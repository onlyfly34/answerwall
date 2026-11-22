/**
 * The entry for a page that ships this UI itself and talks to a server on
 * another origin: the wall page of the browser extension (docs/web-cells.md).
 * The server's own page starts from `main.tsx` instead.
 */
// First: it configures the validation library before any module builds a schema.
import './infra/zod-config.ts';
import { mountApp } from './app/mount.tsx';
import { createRemoteConnection } from './infra/connection.ts';
import type { TokenStore } from './infra/connection.ts';
import { createServices } from './infra/services.ts';
import type { ShellServices } from './infra/services.ts';

export type { TokenStore } from './infra/connection.ts';

export interface EmbeddedOptions {
  root: HTMLElement;
  /** The origin of the AnswerWall server this page was paired with. */
  server: string;
  /** Where the device token is kept between page loads. */
  tokens: TokenStore;
  /** This page can show web cells: the wall is offered the web providers. */
  webProviders?: boolean;
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
  const connection = createRemoteConnection({ base: options.server, tokens: options.tokens });
  const services = createServices({
    connection,
    webProviders: options.webProviders === true,
  });
  return { services, unmount: mountApp(options.root, services) };
}
