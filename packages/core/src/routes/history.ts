import { Hono } from 'hono';
import { AppError } from '../contracts/index.ts';
import type { AppDeps, AppEnv } from '../contracts/index.ts';
import { HistoryQuerySchema } from '../protocol/index.ts';
import type { AskSnapshot, HistoryPage, OkResponse } from '../protocol/index.ts';
import { parse } from './shared.ts';

export function historyRoutes({ storage, asks }: Pick<AppDeps, 'storage' | 'asks'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const turns = storage.turns;

  routes.get('/', async (c) => {
    const query = parse(HistoryQuerySchema, c.req.query());
    return c.json((await turns.list(query)) satisfies HistoryPage);
  });

  routes.get('/:askId', async (c) => {
    const entry = await turns.get(c.req.param('askId'));
    if (!entry) throw new AppError('not_found', 'No such history entry');
    return c.json(entry satisfies AskSnapshot);
  });

  routes.delete('/:askId', async (c) => {
    const outcome = await turns.delete(c.req.param('askId'));
    if (outcome === 'not_found') throw new AppError('not_found', 'No such history entry');
    if (outcome === 'in_progress') {
      throw new AppError('conflict', 'This ask is still running; cancel it first');
    }
    asks.forget(c.req.param('askId'));
    return c.json({ ok: true } satisfies OkResponse);
  });

  return routes;
}
