/**
 * Applies a site rule to the page the content script runs in: finds the
 * message box, types the prompt, submits, waits for the new answer to finish
 * and reads it. It only ever does what a person at the keyboard does in that
 * page: no request of its own, no cookie, no storage, no header.
 *
 * When a part of the rule does not match, the run ends as `failed` and says
 * which part. The page is never left in a state the user cannot continue
 * from by hand.
 */
import type { WebCellStage } from '@answerwall/web/embed';
import type { SiteRule } from '../rules/schema.ts';
import type { ContentResult } from '../shared/protocol.ts';
import { toMarkdown } from './markdown.ts';

export interface EngineTiming {
  /** How often the page is looked at. */
  pollMs: number;
  /** How long to wait for the message box of a page that is still starting. */
  inputMs: number;
  /** How long to wait for the send control to become usable after typing. */
  submitMs: number;
  /** How long to wait for the new answer to appear after submitting. */
  appearMs: number;
  /** A finished answer that stays empty for this long is a rule failure. */
  emptyMs: number;
  /** Gives an editor that handled a paste time to show the text. */
  editorMs: number;
}

export const DEFAULT_TIMING: EngineTiming = {
  pollMs: 200,
  inputMs: 15_000,
  submitMs: 5_000,
  appearMs: 90_000,
  emptyMs: 20_000,
  editorMs: 500,
};

export interface EngineEnvironment {
  document: Document;
  /** `location.pathname` of the page, read again whenever it is needed. */
  pathname(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  timing: EngineTiming;
}

export interface RunRequest {
  prompt: string;
  fill: boolean;
  read: boolean;
  resume: boolean;
  signal: AbortSignal;
  onStage(stage: WebCellStage): void;
}

const ABORTED = Symbol('aborted');
type Aborted = typeof ABORTED;

function first(document: Document, selectors: readonly string[]): Element | undefined {
  for (const selector of selectors) {
    const found = document.querySelector(selector);
    if (found) return found;
  }
  return undefined;
}

/** The answers on the page, oldest first: the matches of the first selector that matches at all. */
export function answersOf(rule: SiteRule, document: Document): Element[] {
  for (const selector of rule.answer.selectors) {
    const found = document.querySelectorAll(selector);
    if (found.length > 0) return Array.from(found);
  }
  return [];
}

export function isSignedOut(rule: SiteRule, document: Document, pathname: string): boolean {
  return (
    rule.signedOut.paths.some((path) => pathname.startsWith(path)) ||
    first(document, rule.signedOut.selectors) !== undefined
  );
}

const isEditable = (element: Element): boolean =>
  (element as HTMLElement).isContentEditable ||
  ['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'false');

const isField = (element: Element): element is HTMLTextAreaElement | HTMLInputElement =>
  element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';

/** What the message box currently holds. */
export function textOf(input: Element): string {
  return isField(input) ? input.value : (input.textContent ?? '');
}

function announceInput(input: Element, text: string): void {
  const view = input.ownerDocument.defaultView;
  const InputEventType = view?.InputEvent ?? InputEvent;
  input.dispatchEvent(
    new InputEventType('input', { bubbles: true, inputType: 'insertText', data: text }),
  );
}

/**
 * Types `text` into the message box the way the page's own code notices:
 * a field through the native value setter and an `input` event; a rich
 * editor through a paste, then the browser's own text insertion, then its
 * text content.
 */
export async function fillInput(
  input: Element,
  text: string,
  environment: Pick<EngineEnvironment, 'sleep' | 'timing'>,
): Promise<boolean> {
  const document = input.ownerDocument;
  const view = document.defaultView;
  (input as HTMLElement).focus();

  if (isField(input)) {
    // A framework that tracks the value property sees the native setter.
    const prototype = Object.getPrototypeOf(input) as object;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(input, text);
    else input.value = text;
    announceInput(input, text);
    return textOf(input) === text;
  }
  if (!isEditable(input)) return false;

  // Replace whatever the box holds, as select-all and typing would.
  try {
    const range = document.createRange();
    range.selectNodeContents(input);
    const selection = view?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // No selection in this environment: the fallbacks below do not need one.
  }

  // 1. A paste: rich editors take plain text from it, line breaks included.
  // An editor that handles the paste itself cancels the event.
  const pasted = paste(input, text);
  if (pasted) {
    const deadline = environment.timing.editorMs;
    for (let waited = 0; waited < deadline && textOf(input).trim() === ''; waited += 25) {
      await environment.sleep(25);
    }
    if (textOf(input).trim() !== '') return true;
  }

  // 2. The browser's own insertion, which fires the events typing would.
  if (insertText(document, text) && textOf(input).trim() !== '') return true;

  // 3. The plain text, with the event a framework listens for.
  input.textContent = text;
  announceInput(input, text);
  return textOf(input).trim() !== '';
}

/** `document.execCommand('insertText')`, where the environment has it. */
function insertText(document: Document, text: string): boolean {
  try {
    const owner = document as Partial<Pick<Document, 'execCommand'>>;
    return typeof owner.execCommand === 'function' && owner.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

/** Dispatches a paste of plain text; `true` when an editor took it (it cancelled the event). */
function paste(input: Element, text: string): boolean {
  const view = input.ownerDocument.defaultView;
  try {
    if (!view || !('DataTransfer' in view) || !('ClipboardEvent' in view)) return false;
    const data = new view.DataTransfer();
    data.setData('text/plain', text);
    return !input.dispatchEvent(
      new view.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  } catch {
    return false;
  }
}

function isDisabled(control: Element): boolean {
  return (
    (control as HTMLButtonElement).disabled === true ||
    control.getAttribute('aria-disabled') === 'true'
  );
}

function pressEnter(input: Element): void {
  const view = input.ownerDocument.defaultView;
  const KeyboardEventType = view?.KeyboardEvent ?? KeyboardEvent;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(
      new KeyboardEventType(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

/** The answer's text as Markdown: the part the rule names, without what it strips. */
export function readAnswer(rule: SiteRule, answer: Element): string {
  let content = answer;
  for (const selector of rule.answer.content) {
    const found = answer.matches(selector) ? answer : answer.querySelector(selector);
    if (found) {
      content = found;
      break;
    }
  }
  return toMarkdown(content, rule.answer.strip);
}

const matchesWithin = (element: Element, selectors: readonly string[]): boolean =>
  selectors.some((selector) => element.matches(selector) || element.querySelector(selector));

const failed = (
  code: Extract<ContentResult, { outcome: 'failed' }>['code'],
  detail: Extract<ContentResult, { outcome: 'failed' }>['detail'],
): ContentResult => ({ outcome: 'failed', code, detail });

/**
 * One run of a rule. Resolves with the result, or with `undefined` when
 * `signal` fired (nothing is reported for an aborted run).
 */
export async function runRule(
  rule: SiteRule,
  environment: EngineEnvironment,
  request: RunRequest,
): Promise<ContentResult | undefined> {
  const { document, timing } = environment;
  const { signal } = request;

  /** Polls until `probe` returns something; `undefined` after `timeoutMs`, `ABORTED` on abort. */
  async function waitFor<T>(
    probe: () => T | undefined,
    timeoutMs: number,
  ): Promise<T | undefined | Aborted> {
    const started = environment.now();
    for (;;) {
      if (signal.aborted) return ABORTED;
      const value = probe();
      if (value !== undefined) return value;
      if (environment.now() - started >= timeoutMs) return undefined;
      await environment.sleep(timing.pollMs);
    }
  }

  const signedOut = (): boolean => isSignedOut(rule, document, environment.pathname());
  if (signedOut()) return failed('not_logged_in', 'signed_out');

  // What is on the page before this run is not its answer.
  const before = request.resume ? 0 : answersOf(rule, document).length;
  const newAnswer = (): Element | undefined => {
    const answers = answersOf(rule, document);
    return answers.length > before ? answers[answers.length - 1] : undefined;
  };

  if (request.fill && !request.resume) {
    request.onStage('filling');
    const input = await waitFor(() => first(document, rule.input.selectors), timing.inputMs);
    if (input === ABORTED) return undefined;
    if (!input)
      return signedOut() ? failed('not_logged_in', 'signed_out') : failed('bad_output', 'input');
    if (!(await fillInput(input, request.prompt, environment)))
      return failed('bad_output', 'input');

    const control = await waitFor(() => {
      const found = first(document, rule.submit.selectors);
      return found && !isDisabled(found) ? found : undefined;
    }, timing.submitMs);
    if (control === ABORTED) return undefined;
    if (control) (control as HTMLElement).click();
    else if (rule.submit.enterKey) pressEnter(input);
    else return failed('bad_output', 'submit');
    if (!request.read) return { outcome: 'submitted' };
    request.onStage('answering');
  } else {
    if (!request.read) return { outcome: 'submitted' };
    // The user types and sends by hand; the run only watches for the answer.
    request.onStage(request.resume ? 'answering' : 'awaiting_hand');
  }

  const typedHere = request.fill && !request.resume;
  const appeared = await waitFor(newAnswer, typedHere ? timing.appearMs : Number.POSITIVE_INFINITY);
  if (appeared === ABORTED) return undefined;
  if (!appeared) return failed('bad_output', 'answer');
  if (!typedHere && !request.resume) request.onStage('answering');

  // Finished: nothing says "busy", the rule's own mark (if it has one) is
  // there, and the text has stopped changing.
  let lastText: string | undefined;
  let lastChange = environment.now();
  for (;;) {
    if (signal.aborted) return undefined;
    const answer = newAnswer();
    if (answer) {
      if (matchesWithin(answer, rule.finished.failed)) return failed('unknown', 'answer');
      const text = readAnswer(rule, answer);
      if (text !== lastText) {
        lastText = text;
        lastChange = environment.now();
      }
      const busy = first(document, rule.finished.busy) !== undefined;
      const marked = rule.finished.done.length === 0 || matchesWithin(answer, rule.finished.done);
      const quietFor = environment.now() - lastChange;
      if (!busy && marked && quietFor >= rule.finished.quietMs) {
        if (text !== '') return { outcome: 'done', text };
        if (quietFor >= timing.emptyMs) return failed('bad_output', 'empty');
      }
    }
    await environment.sleep(timing.pollMs);
  }
}
