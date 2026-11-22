import type { Device, PairRequest, PairingCodeResponse } from '../protocol/index.ts';

/** Who an authenticated request belongs to. */
export type AuthContext = { kind: 'device'; deviceId: string } | { kind: 'static-token' };

export interface AuthService {
  /**
   * Resolves a device token or the static token (constant-time) and records
   * the device as used. `null` when the token is unknown or revoked.
   */
  authenticate(token: string): Promise<AuthContext | null>;

  /**
   * Consumes a pairing code and registers a device. The returned token is
   * shown to nobody: the route puts it in the session cookie.
   * @throws AppError `invalid_code` | `device_limit`
   */
  pair(request: PairRequest): Promise<{ token: string; device: Device }>;

  /** A new single-use pairing code; earlier unused codes stay valid until they expire. */
  createPairingCode(): Promise<PairingCodeResponse>;

  /**
   * Startup hook: when no device is paired, creates a pairing code and
   * writes it to the log (the one secret that is meant to be logged).
   */
  bootstrap(): Promise<void>;

  /** Every paired device, with `current` set for the caller's own. */
  listDevices(caller: AuthContext): Promise<Device[]>;
  getDevice(caller: AuthContext): Promise<Device | null>;
  /** `false` when no such device exists. */
  revokeDevice(deviceId: string): Promise<boolean>;
  /** Revokes the caller's own device; a no-op for the static token. */
  logout(caller: AuthContext): Promise<void>;
}
