/**
 * Asks a remote address who it is before the window loads it: validates the
 * URL, requests `GET /api/meta` and compares the answer with this app.
 * The request goes through the remote window's own network session, so the
 * certificates Windows trusts are the ones that count, and a certificate
 * error is an error: nothing here or anywhere else bypasses it.
 */
import { API_VERSION, API_PATHS, BRAND, MetaSchema } from '@answerwall/core/protocol';
import type { ConnectionProblem, RemoteCheckResult } from '../shared/ipc.ts';
import { validateRemoteUrl } from './remote-url.ts';
import type { Resolver } from './remote-url.ts';

export const PROBE_TIMEOUT_MS = 10_000;
/** A meta document is a few hundred bytes; more than this is not one. */
const MAX_META_BYTES = 64 * 1024;

/** The response of the meta request, or how it failed. */
export type MetaFetch =
  { ok: true; status: number; body: string } | { ok: false; error: string; timedOut: boolean };

export interface ProbeDeps {
  resolve: Resolver;
  /** `GET <url>` without credentials and without following redirects. */
  fetchMeta(url: string): Promise<MetaFetch>;
  appVersion: string;
}

/**
 * Chromium's network errors for a certificate it does not accept
 * (`net::ERR_CERT_…`). A failed handshake of another kind is not one.
 */
const CERTIFICATE_ERROR = /CERT_|certificate/i;

export function classifyFetchFailure(failure: {
  error: string;
  timedOut: boolean;
}): ConnectionProblem {
  if (failure.timedOut) return { kind: 'timeout' };
  if (CERTIFICATE_ERROR.test(failure.error)) return { kind: 'certificate' };
  return { kind: 'unreachable' };
}

export async function probeRemote(input: string, deps: ProbeDeps): Promise<RemoteCheckResult> {
  const validated = await validateRemoteUrl(input, deps.resolve);
  if (!validated.ok) return { ok: false, problem: { kind: 'url', detail: validated.problem } };

  const response = await deps.fetchMeta(`${validated.origin}${API_PATHS.meta}`);
  if (!response.ok) return { ok: false, problem: classifyFetchFailure(response) };
  if (response.status !== 200 || response.body.length > MAX_META_BYTES) {
    return { ok: false, problem: { kind: 'not_a_server' } };
  }
  let document: unknown;
  try {
    document = JSON.parse(response.body);
  } catch {
    return { ok: false, problem: { kind: 'not_a_server' } };
  }
  const meta = MetaSchema.safeParse(document);
  if (!meta.success || meta.data.name !== BRAND.name) {
    return { ok: false, problem: { kind: 'not_a_server' } };
  }
  if (meta.data.mode !== 'server') return { ok: false, problem: { kind: 'desktop_instance' } };

  return {
    ok: true,
    server: {
      origin: validated.origin,
      insecure: validated.insecure,
      name: meta.data.name,
      version: meta.data.version,
      apiVersion: meta.data.apiVersion,
      apiMismatch: meta.data.apiVersion !== API_VERSION,
      versionMismatch: meta.data.version !== deps.appVersion,
    },
  };
}
