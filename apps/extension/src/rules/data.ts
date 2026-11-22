/**
 * The site rules this build ships: one data file per site. The test build
 * (`__TEST_SITE__`) also carries the rule of the stand-in site of the
 * automated tests; a release never contains it (the build checks that).
 *
 * This module imports nothing but the data, so the content script that
 * bundles it stays small.
 */
import chatgpt from '../../rules/chatgpt.json';
import claude from '../../rules/claude.json';
import gemini from '../../rules/gemini.json';
import grok from '../../rules/grok.json';
import standin from '../../rules/standin.json';
import zai from '../../rules/zai.json';
import type { SiteRule } from './schema.ts';

export const RULES: readonly SiteRule[] = [claude, chatgpt, gemini, grok, zai];

/** The rule of the stand-in site; `undefined` in a release build. */
export const TEST_SITE_RULE: SiteRule | undefined = __TEST_SITE__ ? standin : undefined;

/** The rule for a page on `host`, as the content script needs it. */
export function ruleForHost(host: string): SiteRule | undefined {
  if (TEST_SITE_RULE?.host === host) return TEST_SITE_RULE;
  return RULES.find((rule) => rule.host === host);
}
