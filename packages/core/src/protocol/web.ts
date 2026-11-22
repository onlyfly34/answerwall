import { z } from 'zod';
import type { ProviderErrorCode } from './errors.ts';

/**
 * Web cells (docs/DECISIONS.md §5.4): a vendor's own web app shown in a frame
 * of the browser extension's wall page. The server never contacts these
 * sites and never runs a web slot; it records the slot and stores the result
 * the paired client submits.
 */

/** The sites a web provider can stand for. The list is fixed: a site is added here, with its rule file in the extension. */
export const WEB_SITES = [
  { id: 'claude', host: 'claude.ai', label: 'Claude (web)' },
  { id: 'chatgpt', host: 'chatgpt.com', label: 'ChatGPT (web)' },
  { id: 'gemini', host: 'gemini.google.com', label: 'Gemini (web)' },
  { id: 'grok', host: 'grok.com', label: 'Grok (web)' },
  { id: 'zai', host: 'chat.z.ai', label: 'Z.ai (web)' },
] as const;

export type WebSiteId = (typeof WEB_SITES)[number]['id'];
export const WEB_SITE_IDS = WEB_SITES.map((site) => site.id) as [WebSiteId, ...WebSiteId[]];
export const WebSiteIdSchema = z.enum(WEB_SITE_IDS);

/** The one provider id a site's instance can have, so a site is configured at most once. */
export function webProviderId(site: WebSiteId): string {
  return `web-${site}`;
}

/** The id Chromium gives an extension: 32 letters from `a` to `p`. */
export const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/, '32 letters from a to p');

export const MAX_EXTENSION_IDS = 8;

export const WebCellsSettingsSchema = z.object({
  /**
   * The master switch. Off: no web slot is accepted, and every request whose
   * `Origin` is a browser extension is refused.
   */
  enabled: z.boolean(),
  /** The extension may type the prompt into the site and submit it. */
  fillPrompt: z.boolean(),
  /**
   * The extension may read the finished answer and send it here. Off: the
   * server accepts no web slot (there would be nothing to store) and no
   * answer text.
   */
  readAnswer: z.boolean(),
  /**
   * The extensions whose pages may use the API, by id. Exact ids only: there
   * is no wildcard. Ignored while `enabled` is off.
   */
  extensionIds: z
    .array(ExtensionIdSchema)
    .max(MAX_EXTENSION_IDS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'extension ids must be unique' }),
});
export type WebCellsSettings = z.infer<typeof WebCellsSettingsSchema>;

export const WebCellsPatchSchema = WebCellsSettingsSchema.partial();
export type WebCellsPatch = z.infer<typeof WebCellsPatchSchema>;

/** Everything off: the state of a fresh installation, and of a document written before web cells existed. */
export const DEFAULT_WEB_CELLS: WebCellsSettings = {
  enabled: false,
  fillPrompt: false,
  readAnswer: false,
  extensionIds: [],
};

/** `chrome-extension://<id>` when `origin` is exactly that, else `undefined`. */
export function extensionIdOfOrigin(origin: string): string | undefined {
  return /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1];
}

/** Why a web slot failed, in the words of the slot error codes every cell already shows. */
export const WEB_FAILURE_CODES = [
  /** The site shows its sign-in page. */
  'not_logged_in',
  'quota',
  'rate_limited',
  'network',
  'prompt_too_long',
  /** The site rule found no input, no submit control or no answer: the site changed. */
  'bad_output',
  /** The site cannot be shown or driven here (it refused the frame, or filling is switched off and nothing was typed). */
  'unsupported',
  'unknown',
] as const satisfies readonly ProviderErrorCode[];
export const WebFailureCodeSchema = z.enum(WEB_FAILURE_CODES);
export type WebFailureCode = z.infer<typeof WebFailureCodeSchema>;

/** Longest reason or message a client may attach to a failed or cancelled web slot. */
export const WEB_RESULT_MESSAGE_MAX = 500;

const reason = z.string().trim().max(WEB_RESULT_MESSAGE_MAX);

/**
 * Body of `POST /api/ask/:askId/slots/:slotId/result`: the one result of a
 * web slot, from the client that created the ask.
 *
 * - `done`: the finished answer as plain text or Markdown. It is stored and
 *   rendered like any other answer; beyond the per-slot output limit it is
 *   truncated and flagged.
 * - `failed`: the slot ends as `error` with this code and message.
 * - `cancelled`: the slot ends as `cancelled`; a reason, when given, is kept
 *   as a notice.
 */
export const WebResultRequestSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), text: z.string().min(1) }),
  z.object({
    outcome: z.literal('failed'),
    code: WebFailureCodeSchema,
    message: reason.optional(),
  }),
  z.object({ outcome: z.literal('cancelled'), reason: reason.optional() }),
]);
export type WebResultRequest = z.infer<typeof WebResultRequestSchema>;

export const WebResultResponseSchema = z.object({
  /** The slot's status after this result. */
  status: z.enum(['done', 'error', 'cancelled']),
  /** The text was longer than the per-slot output limit and was cut. */
  truncated: z.boolean(),
});
export type WebResultResponse = z.infer<typeof WebResultResponseSchema>;
