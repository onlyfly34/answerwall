import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { outputLines, planRelease } from '../../../.github/scripts/release-plan.mjs';

/**
 * What a run of the release workflow may do (docs/DECISIONS.md §10,
 * docs/RELEASING.md). The decision is a script so that it can be tested
 * here; the workflow files are read to check that they act on it.
 */
const workflow = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)),
    'utf8',
  );

const pushed = (tag: string, tags: string[] = []) =>
  planRelease({ eventName: 'push', ref: `refs/tags/${tag}`, tags: [...tags, tag] });

describe('planRelease', () => {
  test('the push of a tag is a release', () => {
    expect(pushed('v1.2.3')).toEqual({
      publish: true,
      tag: 'v1.2.3',
      version: '1.2.3',
      prerelease: false,
      imageTags: ['1.2.3', '1.2', 'latest'],
      latest: true,
    });
  });

  test('a manual run publishes nothing, also when it was started on a tag', () => {
    for (const ref of ['refs/heads/main', 'refs/tags/v1.2.3', 'refs/tags/v1.2.3-rc.1']) {
      expect(planRelease({ eventName: 'workflow_dispatch', ref, tags: ['v1.2.3'] })).toEqual({
        publish: false,
      });
    }
    // Nor does anything else that is not the push of a tag.
    expect(planRelease({ eventName: 'push', ref: 'refs/heads/main', tags: [] })).toEqual({
      publish: false,
    });
    expect(planRelease({ eventName: 'schedule', ref: 'refs/tags/v1.2.3', tags: [] })).toEqual({
      publish: false,
    });
  });

  test('a pre-release gets its own image tag and is never the latest', () => {
    expect(pushed('v1.2.3-rc.1', ['v1.2.2'])).toEqual({
      publish: true,
      tag: 'v1.2.3-rc.1',
      version: '1.2.3-rc.1',
      prerelease: true,
      imageTags: ['1.2.3-rc.1'],
      latest: false,
    });
  });

  test('a fix for an older version line does not move latest backwards', () => {
    const plan = pushed('v0.1.1', ['v0.1.0', 'v0.2.0', 'v0.1.0-rc.1']);

    expect(plan).toMatchObject({ imageTags: ['0.1.1', '0.1'], latest: false });
  });

  test('an older patch of a line moves neither that line’s tag nor latest', () => {
    expect(pushed('v1.2.3', ['v1.2.4'])).toMatchObject({ imageTags: ['1.2.3'], latest: false });
  });

  test('versions are compared as numbers, and pre-releases of later versions do not count', () => {
    expect(pushed('v0.10.0', ['v0.9.0', 'v0.9.12'])).toMatchObject({
      imageTags: ['0.10.0', '0.10', 'latest'],
      latest: true,
    });
    expect(pushed('v0.9.13', ['v0.10.0'])).toMatchObject({ latest: false });
    expect(pushed('v1.0.0', ['v1.1.0-rc.1', 'v2.0.0-beta.1'])).toMatchObject({ latest: true });
    // Tags of another shape are not releases.
    expect(pushed('v1.0.0', ['nightly', 'v9', 'docs-v3.0.0'])).toMatchObject({ latest: true });
  });

  test('the first release is the latest', () => {
    expect(pushed('v0.1.0', ['v0.1.0-rc.1'])).toMatchObject({
      imageTags: ['0.1.0', '0.1', 'latest'],
      latest: true,
    });
  });

  test.each(['v1.2', '1.2.3', 'v1.2.3.4', 'vnext', 'v1.2.3-', 'v1.2.3+build', 'release-1.2.3'])(
    'the pushed tag %s is refused',
    (tag) => {
      expect(() => pushed(tag)).toThrow(/is not v<major>/);
    },
  );
});

describe('outputLines', () => {
  test('a build-only run has one output', () => {
    expect(outputLines({ publish: false })).toEqual(['publish=false']);
  });

  test('a release names its image tags and whether it is the latest', () => {
    expect(outputLines(pushed('v0.1.1', ['v0.2.0']))).toEqual([
      'publish=true',
      'tag=v0.1.1',
      'version=0.1.1',
      'prerelease=false',
      'image-tags=0.1.1 0.1',
      'latest=false',
    ]);
  });
});

describe('the workflows act on the plan', () => {
  const release = workflow('release.yml');
  const docker = workflow('docker.yml');

  test('the plan sees the event, not only the ref', () => {
    expect(release).toContain('node .github/scripts/release-plan.mjs');
    expect(release).toContain('EVENT_NAME: ${{ github.event_name }}');
    // No second decision beside the script's.
    expect(release).not.toMatch(/refs\/tags\/\*/);
  });

  test('a published release is refused before any job builds or pushes', () => {
    const plan = release.slice(release.indexOf('  plan:'), release.indexOf('  verify:'));
    expect(plan).toContain('Refuse a tag that is already released');
    expect(plan).toContain('is already published');
    for (const job of ['verify', 'build', 'windows-installer', 'container']) {
      const body = release.slice(release.indexOf(`\n  ${job}:`));
      expect(/needs: \[?plan/.test(body.slice(0, body.indexOf('\n\n'))), job).toBe(true);
    }
  });

  test('a draft of an earlier run is replaced, so its notes name this run’s image', () => {
    expect(release).toContain('gh release delete "$TAG" --yes');
    expect(release).not.toContain('--cleanup-tag');
    expect(release).not.toContain('Reusing the existing draft');
  });

  test('the image tags and "Latest" come from the plan', () => {
    expect(release).toContain('image-tags: ${{ needs.plan.outputs.image-tags }}');
    expect(release).toContain('--latest="$LATEST"');
    expect(docker).toContain('IMAGE_TAGS: ${{ inputs.image-tags }}');
    // The image workflow no longer decides by itself that a release is the latest.
    expect(docker).not.toMatch(/tags\+=\(.*latest/);
  });
});
