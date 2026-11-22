/**
 * The one header rule of the extension (docs/DECISIONS.md §11): in the tab
 * of a wall page, the response headers that refuse framing are removed from
 * the documents of frames on the listed vendor hosts. It is a session rule
 * (gone with the browser session), its id is the tab's id, and it changes
 * no request header, no other resource type, no other tab and no other host.
 */

/** A rule's id is the id of the wall tab it belongs to. */
export type FrameRule = chrome.declarativeNetRequest.Rule;

export function frameRule(tabId: number, extensionId: string, hosts: readonly string[]): FrameRule {
  return {
    id: tabId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        // The whole header goes: the API cannot edit `frame-ancestors` alone.
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: {
      // Only this tab ...
      tabIds: [tabId],
      // ... and only a frame the wall page opened, or one a listed site
      // navigated itself (a redirect after signing in, a form). A page of any
      // other site that ends up in this tab starts requests under its own
      // name and gets nothing.
      initiatorDomains: [extensionId, ...hosts],
      requestDomains: [...hosts],
      resourceTypes: ['sub_frame'],
    },
  };
}

type RuleApi = Pick<typeof chrome.declarativeNetRequest, 'updateSessionRules' | 'getSessionRules'>;

export async function installFrameRule(
  api: RuleApi,
  tabId: number,
  extensionId: string,
  hosts: readonly string[],
): Promise<void> {
  await api.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [frameRule(tabId, extensionId, hosts)],
  });
}

export async function removeFrameRule(api: RuleApi, tabId: number): Promise<void> {
  await api.updateSessionRules({ removeRuleIds: [tabId] });
}

/**
 * Removes the rule of every tab that no longer shows a wall page.
 * `showsWall` answers for one tab; the rules' ids are the tabs to ask about.
 */
export async function sweepFrameRules(
  api: RuleApi,
  showsWall: (tabId: number) => Promise<boolean>,
  only?: number,
): Promise<number[]> {
  const rules = await api.getSessionRules();
  const stale: number[] = [];
  for (const rule of rules) {
    if (only !== undefined && rule.id !== only) continue;
    if (!(await showsWall(rule.id))) stale.push(rule.id);
  }
  if (stale.length > 0) await api.updateSessionRules({ removeRuleIds: stale });
  return stale;
}
