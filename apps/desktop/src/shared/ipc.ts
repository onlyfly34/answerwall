/**
 * What crosses a process boundary inside the desktop shell: the channels
 * between a page's preload and the main process, and the messages between
 * the main process and the core host. Types only, plus the channel names.
 */
import type { Language } from '@answerwall/core/protocol';
import type { MessageKey } from './messages/index.ts';

export const CHANNELS = {
  /** Local page → main: open a terminal running one CLI's login command. */
  openLoginTerminal: 'desktop:open-login-terminal',
  connectionState: 'connection:state',
  connectionCheck: 'connection:check',
  connectionApply: 'connection:apply',
  connectionSetUpdateCheck: 'connection:set-update-check',
} as const;

export type ConnectionMode = 'local' | 'remote';

/** Why the app could not be opened in the requested mode. */
export type ConnectionProblem =
  /** The URL is not acceptable; `detail` names the rule. */
  | { kind: 'url'; detail: RemoteUrlProblem }
  | { kind: 'unreachable' }
  | { kind: 'certificate' }
  | { kind: 'timeout' }
  /** Something answered, but not as this product's server does. */
  | { kind: 'not_a_server' }
  /** The address belongs to another computer's desktop app, which accepts no devices. */
  | { kind: 'desktop_instance' }
  | { kind: 'local_failed' };

export type RemoteUrlProblem =
  | 'empty'
  | 'invalid'
  | 'scheme'
  | 'credentials'
  | 'path'
  /** Plain HTTP to an address that is not loopback or private. */
  | 'insecure_public'
  /** Plain HTTP that would go through a proxy, which then decides where it ends up. */
  | 'insecure_proxy'
  /** Plain HTTP to a name that could not be resolved, so its address class is unknown. */
  | 'unresolved';

/** What `GET /api/meta` of a remote server said, compared with this app. */
export interface RemoteServerInfo {
  /** The normalised origin that will be loaded. */
  origin: string;
  /** Plain HTTP: allowed for this address, shown with a warning. */
  insecure: boolean;
  name: string;
  version: string;
  apiVersion: number;
  /** The server speaks another protocol version than this app was built with. */
  apiMismatch: boolean;
  /** The server is another release than this app. */
  versionMismatch: boolean;
}

export type RemoteCheckResult =
  { ok: true; server: RemoteServerInfo } | { ok: false; problem: ConnectionProblem };

export interface ConnectionState {
  language: Language;
  /** Every string of the page, in `language`. */
  messages: Record<MessageKey, string>;
  appVersion: string;
  apiVersion: number;
  /** `undefined` on first run. */
  mode: ConnectionMode | undefined;
  remoteUrl: string;
  updateCheck: boolean;
  /** Whether this build can update itself at all. */
  updatesSupported: boolean;
  /** Set when the page was opened because the saved choice did not work. */
  problem: ConnectionProblem | undefined;
}

export type ConnectionChoice = { mode: 'local' } | { mode: 'remote'; url: string };

export type ApplyResult = { ok: true } | { ok: false; problem: ConnectionProblem };

/** The API of the connection page (`window.<slug>Connection`). */
export interface ConnectionApi {
  state(): Promise<ConnectionState>;
  check(url: string): Promise<RemoteCheckResult>;
  apply(choice: ConnectionChoice): Promise<ApplyResult>;
  setUpdateCheck(enabled: boolean): Promise<void>;
}

/** Main → core host. */
export type HostRequest =
  | { type: 'start'; config: HostConfig }
  | { type: 'shutdown' }
  /** Sent every few seconds: the main process still runs (see `parent-watch.ts`). */
  | { type: 'alive' }
  | { type: 'secret-result'; id: number; ok: true; value?: string }
  /** `unavailable`: the system offers no encryption, so nothing was stored. */
  | { type: 'secret-result'; id: number; ok: false; reason: 'unavailable' | 'error' };

/** Core host → main. */
export type HostEvent =
  | { type: 'listening'; port: number }
  | { type: 'failed'; reason: 'address_in_use' | 'error' }
  | { type: 'secret'; id: number; op: 'get' | 'delete'; key: string }
  | { type: 'secret'; id: number; op: 'set'; key: string; value: string };

/** What the main process tells the core host at start; the only place the launch token travels. */
export interface HostConfig {
  version: string;
  port: number;
  dataDir: string;
  webRoot: string;
  token: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** The helper script that ends the CLI children when the host dies without warning. */
  reaper: string;
}
