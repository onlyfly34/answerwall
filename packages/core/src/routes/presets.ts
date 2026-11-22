import { Hono } from 'hono';
import { AppError } from '../contracts/index.ts';
import type { AppDeps, AppEnv } from '../contracts/index.ts';
import { EntityIdSchema, MAX_PRESETS, PresetInputSchema } from '../protocol/index.ts';
import type { OkResponse, Preset, PresetsResponse } from '../protocol/index.ts';
import { parse, readJson } from './shared.ts';

export function presetRoutes({ storage, clock }: Pick<AppDeps, 'storage' | 'clock'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const presets = storage.presets;

  routes.get('/', async (c) => c.json({ presets: await presets.list() } satisfies PresetsResponse));

  routes.get('/:id', async (c) => {
    const preset = await presets.get(c.req.param('id'));
    if (!preset) throw new AppError('not_found', 'No such preset');
    return c.json(preset satisfies Preset);
  });

  routes.put('/:id', async (c) => {
    const id = parse(EntityIdSchema, c.req.param('id'));
    const input = await readJson(c, PresetInputSchema);
    const existing = await presets.get(id);
    if (!existing && (await presets.list()).length >= MAX_PRESETS) {
      throw new AppError('conflict', `At most ${MAX_PRESETS} presets can be saved`);
    }
    const now = clock.now();
    const preset: Preset = { ...input, id, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await presets.put(preset);
    return c.json(preset);
  });

  routes.delete('/:id', async (c) => {
    if (!(await presets.delete(c.req.param('id')))) {
      throw new AppError('not_found', 'No such preset');
    }
    return c.json({ ok: true } satisfies OkResponse);
  });

  return routes;
}
