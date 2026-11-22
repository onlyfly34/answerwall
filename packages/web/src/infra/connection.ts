import { ApiError } from '../contracts/services.ts';
import type { ApiClient } from '../contracts/services.ts';
import { defaultFetch } from './api.ts';
import type { Fetch } from './api.ts';

/**
 * Where a page that does not come from the server keeps its device token: the
 * browser extension's own storage. Reads and writes may be asynchronous.
 */
export interface TokenStore {
  get(): Promise<string | undefined> | string | undefined;
  /** `undefined` removes the token. */
  set(token: string | undefined): Promise<void> | void;
}

export interface RemoteConnectionOptions {
  /** The server's origin, for example `https://wall.example.com`. */
  base: string;
  tokens: TokenStore;
  fetch?: Fetch;
}

/**
 * The connection of a page on another origin than the server (the extension's
 * wall page). There is no cookie: every request goes to the one configured
 * origin with `Authorization: Bearer <device token>`.
 */
export interface RemoteConnection {
  /** The server's origin. */
  readonly origin: string;
  /**
   * `fetch` for the API: resolves the path against the server's origin, adds
   * the token and never sends or stores a cookie. Refuses any other origin,
   * so the token cannot be sent anywhere else. A `401` for a request that
   * carried the current token forgets it: presenting a dead token again and
   * again would count against the failed sign-in limit.
   */
  readonly fetch: Fetch;
  setToken(token: string | undefined): Promise<void>;
}

function requestUrl(input: Parameters<Fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export function createRemoteConnection(options: RemoteConnectionOptions): RemoteConnection {
  const base = new URL(options.base);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('The server address must start with http:// or https://');
  }
  const fetch = options.fetch ?? defaultFetch;
  const { tokens } = options;
  /** The token in memory once it was read or written; the store is asked only once. */
  let cached: { token: string | undefined } | undefined;

  async function current(): Promise<string | undefined> {
    cached ??= { token: (await tokens.get()) || undefined };
    return cached.token;
  }

  async function setToken(token: string | undefined): Promise<void> {
    cached = { token };
    await tokens.set(token);
  }

  return {
    origin: base.origin,
    setToken,
    async fetch(input, init = {}) {
      const url = new URL(requestUrl(input), base.origin);
      if (url.origin !== base.origin) {
        throw new TypeError('A request to another origin than the server was refused');
      }
      const token = await current();
      const headers = new Headers(init.headers);
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetch(url.href, { ...init, headers, credentials: 'omit' });
      if (response.status === 401 && token !== undefined && cached?.token === token) {
        await setToken(undefined);
      }
      return response;
    },
  };
}

/**
 * The API client of a remote page: signing in means keeping the token, and
 * signing out means forgetting it.
 *
 * - `pair`: the server answers an allowed extension with the device token in
 *   the body (and sets no cookie); it is stored and not passed on.
 * - `signIn`: the server checks the token the user typed; it is then stored.
 * - `logout`: the server revokes the device; the token is forgotten.
 */
export function withRemoteSession(api: ApiClient, connection: RemoteConnection): ApiClient {
  return {
    ...api,
    async pair(request) {
      const { token, device } = await api.pair(request);
      if (token === undefined) {
        // The server treated this page as an ordinary browser page: it would
        // have set a cookie this page can never send.
        throw new ApiError('invalid_response', 200, 'The server did not return a device token');
      }
      await connection.setToken(token);
      return { device };
    },
    async signIn(request) {
      const response = await api.signIn(request);
      await connection.setToken(request.token);
      return { device: response.device };
    },
    async logout() {
      await api.logout();
      await connection.setToken(undefined);
    },
  };
}
