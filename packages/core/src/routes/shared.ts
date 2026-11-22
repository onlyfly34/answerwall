import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../contracts/index.ts';
import type { AppEnv } from '../contracts/index.ts';

export type AppContext = Context<AppEnv>;

/** Validates `value`; a failure becomes a 400 naming the first offending field. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.join('.');
  throw new AppError(
    'bad_request',
    path ? `${path}: ${issue?.message}` : (issue?.message ?? 'Invalid request'),
  );
}

/** Reads and validates the JSON body. An empty body counts as `{}`. */
export async function readJson<S extends z.ZodType>(
  c: AppContext,
  schema: S,
): Promise<z.output<S>> {
  const text = await c.req.text();
  let value: unknown = {};
  if (text.trim() !== '') {
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError('bad_request', 'Request body is not valid JSON');
    }
  }
  return parse(schema, value);
}
