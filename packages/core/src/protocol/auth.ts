import { z } from 'zod';
import { EntityIdSchema, TimestampSchema } from './common.ts';

export const MAX_DEVICES = 8;
export const PAIRING_CODE_DIGITS = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** A pairing code is void after this many wrong attempts. */
export const PAIRING_MAX_ATTEMPTS = 5;

export const PairingCodeValueSchema = z
  .string()
  .regex(new RegExp(`^\\d{${PAIRING_CODE_DIGITS}}$`), `${PAIRING_CODE_DIGITS} digits`);

export const DeviceNameSchema = z.string().trim().min(1).max(64);

/** `POST /api/auth/pair`: trades a pairing code for a new device and its session cookie. */
export const PairRequestSchema = z.object({
  code: PairingCodeValueSchema,
  deviceName: DeviceNameSchema,
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

/** `POST /api/auth/session`: trades an existing token for the session cookie. */
export const SessionRequestSchema = z.object({
  token: z.string().min(16).max(512),
});
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

export const DeviceSchema = z.object({
  id: EntityIdSchema,
  name: DeviceNameSchema,
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  /** The device that made this request. */
  current: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** Response of pair and session. `device` is `null` for the static automation token. */
export const SessionResponseSchema = z.object({
  device: DeviceSchema.nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const DevicesResponseSchema = z.object({
  devices: z.array(DeviceSchema),
  maxDevices: z.number().int(),
});
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;

export const PairingCodeResponseSchema = z.object({
  code: PairingCodeValueSchema,
  expiresAt: TimestampSchema,
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;
