import { z } from 'zod';

/** Bumped on any incompatible change to this protocol. */
export const API_VERSION = 2;

export const DeploymentModeSchema = z.enum(['server', 'desktop']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const TlsModeSchema = z.enum(['cert', 'auto', 'off']);
export type TlsMode = z.infer<typeof TlsModeSchema>;

/** `GET /api/meta`, the only unauthenticated read. */
export const MetaSchema = z.object({
  name: z.string(),
  version: z.string(),
  apiVersion: z.number().int(),
  mode: DeploymentModeSchema,
  tls: TlsModeSchema,
  authRequired: z.boolean(),
});
export type Meta = z.infer<typeof MetaSchema>;
