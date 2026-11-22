/** The rules as the wall page uses them: by the site id of the protocol. */
import { WEB_SITES } from '@answerwall/core/protocol';
import type { WebSiteId } from '@answerwall/core/protocol';
import { RULES } from './data.ts';
import type { SiteRule } from './schema.ts';

export { TEST_SITE_RULE } from './data.ts';

/** The site id the stand-in takes over in the test build. */
export const TEST_SITE_ID: WebSiteId = 'claude';

/** The hosts whose pages may be framed, filled in and read: exactly the protocol's list. */
export const SITE_HOSTS: readonly string[] = WEB_SITES.map((site) => site.host);

export function ruleForSite(site: WebSiteId): SiteRule | undefined {
  return RULES.find((rule) => rule.site === site);
}
