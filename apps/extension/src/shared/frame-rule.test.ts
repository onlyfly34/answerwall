import { describe, expect, test } from 'vitest';
import { frameRule, installFrameRule, removeFrameRule, sweepFrameRules } from './frame-rule.ts';
import type { FrameRule } from './frame-rule.ts';

const ID = 'nffcmlcjkacklpololkpdmhcfokannom';
const HOSTS = ['claude.ai', 'chatgpt.com'];

/** The session rules of a browser, as far as these functions use them. */
function fakeRules(initial: FrameRule[] = []) {
  let rules = [...initial];
  return {
    current: () => rules,
    async getSessionRules() {
      return rules;
    },
    async updateSessionRules(options: { removeRuleIds?: number[]; addRules?: FrameRule[] }) {
      rules = rules.filter((rule) => !options.removeRuleIds?.includes(rule.id));
      rules.push(...(options.addRules ?? []));
    },
  };
}

describe('the header rule', () => {
  const rule = frameRule(42, ID, HOSTS);

  test('removes the two headers that refuse framing, and no other', () => {
    expect(rule.action).toEqual({
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    });
    // Response headers only: a request leaves the browser as it would anyway.
    expect(JSON.stringify(rule)).not.toContain('requestHeaders');
    expect(JSON.stringify(rule).toLowerCase()).not.toContain('user-agent');
  });

  test('applies to frame documents on the listed hosts, in the one tab, and nowhere else', () => {
    expect(rule.id).toBe(42);
    expect(rule.condition).toEqual({
      tabIds: [42],
      initiatorDomains: [ID, ...HOSTS],
      requestDomains: HOSTS,
      resourceTypes: ['sub_frame'],
    });
  });

  test('installing twice leaves one rule; removing leaves none', async () => {
    const api = fakeRules();
    await installFrameRule(api, 7, ID, HOSTS);
    await installFrameRule(api, 7, ID, HOSTS);
    expect(api.current()).toEqual([frameRule(7, ID, HOSTS)]);
    await removeFrameRule(api, 7);
    expect(api.current()).toEqual([]);
  });
});

describe('sweeping', () => {
  test('the rule of a tab that no longer shows a wall goes; the others stay', async () => {
    const api = fakeRules([
      frameRule(1, ID, HOSTS),
      frameRule(2, ID, HOSTS),
      frameRule(3, ID, HOSTS),
    ]);
    const removed = await sweepFrameRules(api, async (tabId) => tabId === 2);
    expect(removed).toEqual([1, 3]);
    expect(api.current().map((rule) => rule.id)).toEqual([2]);
  });

  test('asked about one tab, it looks at that tab only', async () => {
    const api = fakeRules([frameRule(1, ID, HOSTS), frameRule(2, ID, HOSTS)]);
    const asked: number[] = [];
    const removed = await sweepFrameRules(
      api,
      async (tabId) => {
        asked.push(tabId);
        return false;
      },
      2,
    );
    expect(asked).toEqual([2]);
    expect(removed).toEqual([2]);
    expect(api.current().map((rule) => rule.id)).toEqual([1]);
  });

  test('a tab without a rule is not asked about at all', async () => {
    const api = fakeRules();
    const removed = await sweepFrameRules(api, async () => {
      throw new Error('nothing to ask');
    });
    expect(removed).toEqual([]);
  });
});
