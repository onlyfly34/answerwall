/**
 * The first run of the wall page: which server, the permission to reach it,
 * and the pairing that yields the device token. The server's address and the
 * token live in the extension's own storage, which no web page can read.
 */
import {
  API_PATHS,
  API_VERSION,
  MetaSchema,
  SessionResponseSchema,
} from '@answerwall/core/protocol';

export const SERVER_KEY = 'server';
export const TOKEN_KEY = 'deviceToken';

export interface ServerAddress {
  /** `https://wall.example.com`, `http://127.0.0.1:7717` */
  origin: string;
  /** The host permission to ask for: this host and nothing else. */
  pattern: string;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;

/**
 * The address as typed: with or without a scheme (without one, a loopback
 * name is taken as `http`, everything else as `https`), with or without a
 * path. `undefined` when it is not an http(s) address.
 */
export function parseServerAddress(input: string): ServerAddress | undefined {
  const typed = input.trim();
  if (typed === '') return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)
    ? typed
    : `${LOOPBACK.test(typed) ? 'http' : 'https'}://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return undefined;
  // A match pattern has no port: the permission covers the host on every port.
  return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
}

export type PairingFailure =
  /** The browser was not allowed to reach the address. */
  | 'permission'
  /** Nothing answered there. */
  | 'unreachable'
  /** Something answered that is not an AnswerWall server. */
  | 'not_a_server'
  /** The server speaks another version of the protocol than this extension. */
  | 'version'
  /** The server refuses this extension: web cells are off, or its ID is not listed. */
  | 'not_allowed'
  /** The pairing code is wrong, used or expired. */
  | 'code'
  | 'rate_limited'
  | 'failed';

export type PairingResult = { ok: true; token: string } | { ok: false; reason: PairingFailure };

export interface PairingEnvironment {
  fetch: typeof fetch;
  permissions: Pick<typeof chrome.permissions, 'contains' | 'request'>;
}

/** Whether the extension may reach the server; asks the user when it may not yet. */
export async function ensurePermission(
  permissions: PairingEnvironment['permissions'],
  pattern: string,
  ask: boolean,
): Promise<boolean> {
  const wanted = { origins: [pattern] };
  try {
    if (await permissions.contains(wanted)) return true;
    return ask ? await permissions.request(wanted) : false;
  } catch {
    return false;
  }
}

/**
 * Pairs with the server. Call it from the user's click: the browser shows
 * its permission prompt only then.
 */
export async function pair(
  environment: PairingEnvironment,
  address: ServerAddress,
  code: string,
  deviceName: string,
): Promise<PairingResult> {
  const fail = (reason: PairingFailure): PairingResult => ({ ok: false, reason });
  if (!(await ensurePermission(environment.permissions, address.pattern, true))) {
    return fail('permission');
  }

  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    // Never a cookie: the token is the only credential of this client.
    environment.fetch(`${address.origin}${path}`, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
    });
  const json = async (response: Response): Promise<unknown> => {
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  };

  let meta: Response;
  try {
    meta = await request(API_PATHS.meta);
  } catch {
    return fail('unreachable');
  }
  const identity = MetaSchema.safeParse(meta.ok ? await json(meta) : undefined);
  if (!identity.success) return fail('not_a_server');
  if (identity.data.apiVersion !== API_VERSION) return fail('version');

  let response: Response;
  try {
    response = await request(API_PATHS.authPair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceName: deviceName.trim() }),
    });
  } catch {
    return fail('unreachable');
  }
  if (response.status === 403) return fail('not_allowed');
  if (response.status === 429) return fail('rate_limited');
  if (response.status === 400 || response.status === 401) return fail('code');
  if (!response.ok) return fail('failed');
  const session = SessionResponseSchema.safeParse(await json(response));
  const token = session.success ? session.data.token : undefined;
  return token === undefined ? fail('failed') : { ok: true, token };
}

export interface StoredConnection {
  server: string | undefined;
}

type Storage = Pick<typeof chrome.storage.local, 'get' | 'set' | 'remove'>;

export async function readConnection(storage: Storage): Promise<StoredConnection> {
  const stored = await storage.get(SERVER_KEY);
  const server = stored[SERVER_KEY];
  return { server: typeof server === 'string' && server !== '' ? server : undefined };
}

export async function saveConnection(
  storage: Storage,
  origin: string,
  token: string,
): Promise<void> {
  await storage.set({ [SERVER_KEY]: origin, [TOKEN_KEY]: token });
}

export async function forgetConnection(storage: Storage): Promise<void> {
  await storage.remove([SERVER_KEY, TOKEN_KEY]);
}

/** The device token as the web UI's connection keeps it. */
export function tokenStore(storage: Storage): {
  get(): Promise<string | undefined>;
  set(token: string | undefined): Promise<void>;
} {
  return {
    async get() {
      const token = (await storage.get(TOKEN_KEY))[TOKEN_KEY];
      return typeof token === 'string' && token !== '' ? token : undefined;
    },
    async set(token) {
      if (token === undefined) await storage.remove(TOKEN_KEY);
      else await storage.set({ [TOKEN_KEY]: token });
    },
  };
}
