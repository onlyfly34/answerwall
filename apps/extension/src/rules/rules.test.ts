import { describe, expect, test } from 'vitest';
import { WEB_SITES } from '@answerwall/core/protocol';
import { buildManifest, chromeVersion, EXTENSION_ID, PUBLIC_KEY } from '../../manifest.mjs';
import { RULES, ruleForHost, TEST_SITE_RULE } from './data.ts';
import { ruleForSite, SITE_HOSTS } from './index.ts';
import { ruleProblems } from './schema.ts';
import type { SiteRule } from './schema.ts';

/** Every data file in `rules/`, by file name. */
const FILES = import.meta.glob<SiteRule>('../../rules/*.json', {
  eager: true,
  import: 'default',
});
const byName = Object.fromEntries(
  Object.entries(FILES).map(([path, rule]) => [/([^/]+)\.json$/.exec(path)?.[1] ?? path, rule]),
);

describe('the rule files', () => {
  test('there is one per site of the protocol, and the stand-in', () => {
    expect(Object.keys(byName).sort()).toEqual(
      [...WEB_SITES.map((site) => site.id), 'standin'].sort(),
    );
  });

  test.each(Object.entries(byName))('%s is a valid rule', (name, rule) => {
    expect(ruleProblems(rule)).toEqual([]);
    expect(rule.site).toBe(name);
  });

  test("a real site's rule names the protocol's host for its site", () => {
    for (const site of WEB_SITES) {
      expect(byName[site.id]?.host, site.id).toBe(site.host);
      expect(ruleForSite(site.id)).toBe(RULES.find((rule) => rule.site === site.id));
    }
    expect(SITE_HOSTS).toEqual(WEB_SITES.map((site) => site.host));
  });

  test('a rule is marked verified only together with the day it was checked', () => {
    for (const rule of Object.values(byName)) {
      expect(rule.verified, rule.site).toBe(rule.verifiedOn !== null);
    }
  });

  test('a release build knows the real hosts and nothing of the stand-in', () => {
    expect(TEST_SITE_RULE).toBeUndefined();
    expect(ruleForHost('claude.ai')?.site).toBe('claude');
    expect(ruleForHost('vendor.localhost')).toBeUndefined();
    expect(ruleForHost('evil.example')).toBeUndefined();
    // A host is matched exactly: no suffix, no sub-domain.
    expect(ruleForHost('www.claude.ai')).toBeUndefined();
    expect(ruleForHost('claude.ai.evil.example')).toBeUndefined();
  });
});

describe('what makes a rule invalid', () => {
  const valid = byName['standin'];
  if (!valid) throw new Error('the stand-in rule is missing');

  test('a selector the browser cannot parse', () => {
    expect(ruleProblems({ ...valid, input: { selectors: ['div >> !!!'] } }).join('\n')).toContain(
      'input.selectors',
    );
  });

  test('no message box, no way to submit, no answer', () => {
    const problems = ruleProblems({
      ...valid,
      input: { selectors: [] },
      submit: { selectors: [], enterKey: false },
      answer: { ...valid.answer, selectors: [] },
    }).join('\n');
    expect(problems).toContain('input.selectors');
    expect(problems).toContain('submit: a selector or enterKey');
    expect(problems).toContain('answer.selectors');
  });

  test('a host with a scheme or a path, a start that is no path, a quiet time out of range', () => {
    expect(ruleProblems({ ...valid, host: 'https://vendor.localhost' }).join()).toContain('host');
    expect(ruleProblems({ ...valid, start: 'https://elsewhere.example/' }).join()).toContain(
      'start',
    );
    expect(
      ruleProblems({ ...valid, finished: { ...valid.finished, quietMs: 5 } }).join(),
    ).toContain('quietMs');
  });

  test('verified without a date, or a date without verified', () => {
    expect(ruleProblems({ ...valid, verified: true, verifiedOn: null }).join()).toContain(
      'verifiedOn',
    );
    expect(ruleProblems({ ...valid, verified: false, verifiedOn: '2026-01-01' }).join()).toContain(
      'verifiedOn',
    );
  });

  test('something that is not a rule at all', () => {
    expect(ruleProblems(null)).toEqual(['the rule is not an object']);
    expect(ruleProblems({}).length).toBeGreaterThan(5);
  });
});

describe('the manifest', () => {
  const hosts = WEB_SITES.map((site) => site.host);
  const manifest = buildManifest({ name: 'AnswerWall', version: '1.2.3-rc.4', hosts });

  test('asks for exactly two permissions and the listed vendor hosts', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['declarativeNetRequestWithHostAccess', 'storage']);
    expect(manifest.host_permissions).toEqual(hosts.map((host) => `https://${host}/*`));
    // The server's origin is asked for when the user pairs, never at installation.
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  test('has no cookie, request-interception, tab or all-sites permission', () => {
    const everything = JSON.stringify(manifest);
    for (const forbidden of [
      'cookies',
      'webRequest',
      '"tabs"',
      'scripting',
      'debugger',
      'history',
      '<all_urls>',
      '"declarativeNetRequest"',
      'externally_connectable',
      'web_accessible_resources',
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
    expect(manifest.host_permissions.join(' ')).not.toMatch(/\*:\/\/|\/\/\*/);
  });

  test('runs its content script on the vendor hosts only, in every frame', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: hosts.map((host) => `https://${host}/*`),
        js: ['content.js'],
        all_frames: true,
        run_at: 'document_idle',
      },
    ]);
  });

  test('carries the version in the two forms Chrome wants', () => {
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.version_name).toBe('1.2.3-rc.4');
    expect(chromeVersion('0.1.0')).toBe('0.1.0');
    expect(() => chromeVersion('next')).toThrow();
  });

  test('only the test build frames the stand-in and reaches a loopback server unasked', () => {
    const test = buildManifest({
      name: 'AnswerWall',
      version: '1.2.3',
      hosts,
      test: { host: 'vendor.localhost', serverPattern: 'http://127.0.0.1/*' },
    });
    expect(test.host_permissions).toContain('http://vendor.localhost/*');
    expect(test.host_permissions).toContain('http://127.0.0.1/*');
    expect(test.name).toContain('test build');
    expect(JSON.stringify(manifest)).not.toContain('localhost');
    expect(JSON.stringify(manifest)).not.toContain('127.0.0.1');
  });

  test('the documented ID is the one Chromium derives from the key', async () => {
    const der = Uint8Array.from(atob(PUBLIC_KEY), (character) => character.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
    const id = Array.from(digest.slice(0, 16), (byte) =>
      [byte >> 4, byte & 15].map((nibble) => String.fromCharCode(97 + nibble)).join(''),
    ).join('');
    expect(id).toBe(EXTENSION_ID);
    expect(manifest.key).toBe(PUBLIC_KEY);
  });
});
