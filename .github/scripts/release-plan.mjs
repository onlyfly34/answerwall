// Decides what a run of the release workflow does: publish or build only,
// and for a release which image tags it sets and whether it becomes "Latest".
//
//   EVENT_NAME=push REF=refs/tags/v1.2.3 EXISTING_TAGS="v1.2.2 v1.3.0" \
//     node .github/scripts/release-plan.mjs
//
// It writes its decision to $GITHUB_OUTPUT (or prints it): publish, tag,
// version, prerelease, image-tags, latest. The rules:
//
// - Only the push of a tag publishes. A manual run builds and tests and
//   publishes nothing, also when a tag was chosen as its ref.
// - A tag is v<major>.<minor>.<patch>, optionally -<pre-release>.
// - A pre-release gets its own image tag only and is never "Latest".
// - A release moves `latest` (and GitHub's "Latest") only when no higher
//   release exists, and `<major>.<minor>` only when no higher patch of that
//   line exists. A fix for an older line therefore never moves `latest` back.
//
// No dependencies.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** The numbers of a release tag; `undefined` for a pre-release or anything else. */
function release(tag) {
  const match = TAG.exec(tag);
  if (!match || match[4] !== undefined) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * @param {{ eventName: string, ref: string, tags: string[] }} run the event
 *   that started the workflow, its ref, and every tag of the repository
 * @returns {{ publish: false } | { publish: true, tag: string, version: string,
 *   prerelease: boolean, imageTags: string[], latest: boolean }}
 * @throws Error for a pushed tag of another shape
 */
export function planRelease({ eventName, ref, tags }) {
  if (eventName !== 'push' || !ref.startsWith('refs/tags/')) return { publish: false };

  const tag = ref.slice('refs/tags/'.length);
  const match = TAG.exec(tag);
  if (!match) {
    throw new Error(
      `The tag ${tag} is not v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<pre-release>.`,
    );
  }
  const version = tag.slice(1);
  if (match[4] !== undefined) {
    return { publish: true, tag, version, prerelease: true, imageTags: [version], latest: false };
  }

  const own = release(tag);
  const others = tags
    .filter((other) => other !== tag)
    .map(release)
    .filter((numbers) => numbers !== undefined);
  const latest = others.every((other) => compare(own, other) > 0);
  const newestOfItsLine = others
    .filter((other) => other[0] === own[0] && other[1] === own[1])
    .every((other) => compare(own, other) > 0);
  return {
    publish: true,
    tag,
    version,
    prerelease: false,
    imageTags: [
      version,
      ...(newestOfItsLine ? [`${own[0]}.${own[1]}`] : []),
      ...(latest ? ['latest'] : []),
    ],
    latest,
  };
}

/** The decision as lines of `name=value`, the format of $GITHUB_OUTPUT. */
export function outputLines(plan) {
  if (!plan.publish) return ['publish=false'];
  return [
    'publish=true',
    `tag=${plan.tag}`,
    `version=${plan.version}`,
    `prerelease=${plan.prerelease}`,
    `image-tags=${plan.imageTags.join(' ')}`,
    `latest=${plan.latest}`,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { EVENT_NAME = '', REF = '', EXISTING_TAGS = '', GITHUB_OUTPUT } = process.env;
  let plan;
  try {
    plan = planRelease({
      eventName: EVENT_NAME,
      ref: REF,
      tags: EXISTING_TAGS.split(/\s+/).filter(Boolean),
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
  const lines = outputLines(plan);
  console.log(plan.publish ? 'A pushed tag: release.' : 'Not the push of a tag: build only.');
  for (const line of lines) console.log(`  ${line}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
