/**
 * A site rule: where a vendor's page has its message box, its send control
 * and its answers, and how to tell that an answer has finished. Rules are
 * data (`rules/<site>.json`, one file per site), so a site change is a rule
 * update and never a code change. Every list is tried in order and the first
 * selector that matches is used.
 */
export interface SiteRule {
  /** The site id of the protocol (`WEB_SITES`), or `standin` for the test site. */
  site: string;
  /** The host the rule applies to; for a real site, the protocol's host. */
  host: string;
  /** Path (and query) a cell opens. */
  start: string;
  /**
   * Checked by hand against the real site (docs/verify-web-cells.md). Until
   * then the rule is a best effort and the cell says so.
   */
  verified: boolean;
  /** The day of the last hand check, `YYYY-MM-DD`; `null` while unverified. */
  verifiedOn: string | null;
  notes: string;
  /** The page is the site's sign-in page: the path starts with one of `paths`, or a selector matches. */
  signedOut: { paths: string[]; selectors: string[] };
  /** The message box: a `textarea`, an `input` or a `contenteditable` element. */
  input: { selectors: string[] };
  /** The send control; `enterKey`: press Enter in the message box when no control is found. */
  submit: { selectors: string[]; enterKey: boolean };
  /**
   * `selectors`: one element per answer, in document order. `content`: the
   * part of an answer that holds its text, when it is not the whole element.
   * `strip`: elements inside the answer that are not part of it (buttons).
   */
  answer: { selectors: string[]; content: string[]; strip: string[] };
  /**
   * `busy`: present anywhere while the site is answering. `done`: must match
   * the answer (or something inside it) once it has finished; empty means no
   * such mark. `failed`: the answer is the site's own error. `quietMs`: how
   * long the text must have stopped changing.
   */
  finished: { busy: string[]; done: string[]; failed: string[]; quietMs: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether the browser (or jsdom) accepts the selector at all. */
function isSelector(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    document.createDocumentFragment().querySelector(value);
    return true;
  } catch {
    return false;
  }
}

const isSelectorList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isSelector);

/**
 * Everything wrong with a rule file, in words; empty when it is valid. The
 * build and the tests run this over every file in `rules/`.
 */
export function ruleProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['the rule is not an object'];
  const problems: string[] = [];
  const check = (condition: boolean, problem: string): void => {
    if (!condition) problems.push(problem);
  };
  const part = (name: string): Record<string, unknown> => {
    const section = value[name];
    if (isRecord(section)) return section;
    problems.push(`${name} is missing`);
    return {};
  };

  check(
    typeof value['site'] === 'string' && /^[a-z]+$/.test(value['site']),
    'site: a lower-case id',
  );
  check(
    typeof value['host'] === 'string' && /^[a-z0-9.-]+$/.test(value['host']),
    'host: a host name without scheme, port or path',
  );
  check(
    typeof value['start'] === 'string' && value['start'].startsWith('/'),
    'start: a path that begins with /',
  );
  check(typeof value['verified'] === 'boolean', 'verified: true or false');
  check(typeof value['notes'] === 'string', 'notes: a string');
  const verifiedOn = value['verifiedOn'];
  check(
    verifiedOn === null ||
      (typeof verifiedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(verifiedOn)),
    'verifiedOn: null or YYYY-MM-DD',
  );
  check(
    (value['verified'] === true) === (typeof verifiedOn === 'string'),
    'verifiedOn: a date exactly when verified is true',
  );

  const signedOut = part('signedOut');
  check(
    Array.isArray(signedOut['paths']) &&
      signedOut['paths'].every((path) => typeof path === 'string' && path.startsWith('/')),
    'signedOut.paths: paths that begin with /',
  );
  check(isSelectorList(signedOut['selectors']), 'signedOut.selectors: valid selectors');

  const input = part('input');
  check(
    isSelectorList(input['selectors']) && input['selectors'].length > 0,
    'input.selectors: at least one valid selector',
  );

  const submit = part('submit');
  check(isSelectorList(submit['selectors']), 'submit.selectors: valid selectors');
  check(typeof submit['enterKey'] === 'boolean', 'submit.enterKey: true or false');
  check(
    (Array.isArray(submit['selectors']) && submit['selectors'].length > 0) ||
      submit['enterKey'] === true,
    'submit: a selector or enterKey',
  );

  const answer = part('answer');
  check(
    isSelectorList(answer['selectors']) && answer['selectors'].length > 0,
    'answer.selectors: at least one valid selector',
  );
  check(isSelectorList(answer['content']), 'answer.content: valid selectors');
  check(isSelectorList(answer['strip']), 'answer.strip: valid selectors');

  const finished = part('finished');
  check(isSelectorList(finished['busy']), 'finished.busy: valid selectors');
  check(isSelectorList(finished['done']), 'finished.done: valid selectors');
  check(isSelectorList(finished['failed']), 'finished.failed: valid selectors');
  const quietMs = finished['quietMs'];
  check(
    typeof quietMs === 'number' && Number.isInteger(quietMs) && quietMs >= 50 && quietMs <= 30_000,
    'finished.quietMs: a whole number of milliseconds from 50 to 30000',
  );
  return problems;
}
