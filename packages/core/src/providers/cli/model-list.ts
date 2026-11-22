import type { ModelInfo } from '../../protocol/index.ts';
import { sanitizeDiagnostic } from '../failure.ts';
import { isRecord } from './run-cli.ts';
import { isModelArgument, text } from './support.ts';

const MAX_MODELS = 200;

function fromJson(value: unknown): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value.models, value.data].find(Array.isArray)
      : undefined;
  if (!Array.isArray(list)) return undefined;
  return list
    .map((entry: unknown) =>
      isRecord(entry)
        ? (text(entry.id) ?? text(entry.slug) ?? text(entry.name) ?? text(entry.model))
        : text(entry),
    )
    .filter((id) => id !== undefined);
}

/** A table or bullet list: the first word of each line, when it looks like a model id. */
function fromLines(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const word = sanitizeDiagnostic(line, 400)
      .replace(/^[-*•>|\s]+/, '')
      .split(/[\s|,]+/, 1)[0];
    // Ids carry a digit, dash or dot; headings and prose words do not.
    if (word && /[-.\d]/.test(word) && /[A-Za-z]/.test(word) && !word.endsWith(':')) ids.push(word);
  }
  return ids;
}

/**
 * Reads the output of a CLI's model listing command whose format is not
 * documented: JSON when it is JSON, otherwise one model per line.
 */
export function parseModelListing(output: string): ModelInfo[] {
  let ids: string[] | undefined;
  try {
    ids = fromJson(JSON.parse(output));
  } catch {
    ids = undefined;
  }
  const unique = new Set((ids ?? fromLines(output)).map((id) => id.trim()).filter(isModelArgument));
  return [...unique].slice(0, MAX_MODELS).map((id) => ({ id }));
}
