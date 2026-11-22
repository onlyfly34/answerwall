/**
 * What the wall page and the content script in a framed site say to each
 * other. The content script talks only to its own extension: over a runtime
 * port, and with one `postMessage` to its parent that lets the wall page tell
 * which of its frames the port belongs to.
 */
import type { WebFailureCode } from '@answerwall/core/protocol';
import type { WebCellFailureDetail, WebCellStage } from '@answerwall/web/embed';

export const PORT_NAME = 'answerwall-web-cell';
export const HELLO_SOURCE = 'answerwall-web-cell';

/** Posted by the content script to its parent window, addressed to the extension's origin only. */
export interface HelloMessage {
  source: typeof HELLO_SOURCE;
  /** Random per document; the same value arrives over the port. */
  nonce: string;
}

export type ContentResult =
  | { outcome: 'done'; text: string }
  | { outcome: 'submitted' }
  | { outcome: 'failed'; code: WebFailureCode; detail: WebCellFailureDetail };

export type FromContent =
  | { type: 'hello'; nonce: string }
  | { type: 'stage'; id: number; stage: WebCellStage }
  | { type: 'result'; id: number; result: ContentResult };

export type ToContent =
  | {
      type: 'run';
      id: number;
      prompt: string;
      /** Type the prompt and submit it. Off: nothing in the page is touched. */
      fill: boolean;
      /** Wait for the answer to finish and return its text. */
      read: boolean;
      /**
       * The page was replaced after the prompt had been submitted: do not
       * type again, read the answer that is (or comes) on this page.
       */
      resume: boolean;
    }
  | { type: 'abort'; id: number };

export function isHelloMessage(value: unknown): value is HelloMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<HelloMessage>;
  return message.source === HELLO_SOURCE && typeof message.nonce === 'string';
}
