/**
 * The single source of the product name. Everything user-visible or
 * name-derived (UI title, CLI binary, cookie, environment prefix, file names)
 * is read from here.
 */
const name = 'AnswerWall';
const slug = 'answerwall';

export const BRAND = {
  name,
  slug,
  cliName: slug,
  envPrefix: `${slug.toUpperCase()}_`,
  sessionCookie: `${slug}_session`,
  databaseFile: `${slug}.sqlite`,
  defaultPort: 7717,
  repository: `https://github.com/onlyfly34/${slug}`,
} as const;
