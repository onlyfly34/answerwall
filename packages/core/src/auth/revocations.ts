import type { AuthService } from '../contracts/index.ts';

/** Tells the parts of a running server that hold something open for a device when its access ends. */
export interface Revocations {
  /** Calls `listener` once when `deviceId` is revoked or signs out; returns the function that stops listening. */
  onRevoked(deviceId: string, listener: () => void): () => void;
  /** Called by the service once the device's token no longer works. */
  announce(deviceId: string): void;
}

export function createRevocations(): Revocations {
  const listeners = new Map<string, Set<() => void>>();
  return {
    onRevoked(deviceId, listener) {
      const forDevice = listeners.get(deviceId) ?? new Set();
      listeners.set(deviceId, forDevice);
      forDevice.add(listener);
      return () => {
        forDevice.delete(listener);
        if (forDevice.size === 0 && listeners.get(deviceId) === forDevice) {
          listeners.delete(deviceId);
        }
      };
    },
    announce(deviceId) {
      const forDevice = listeners.get(deviceId);
      listeners.delete(deviceId);
      for (const listener of forDevice ?? []) listener();
    },
  };
}

/**
 * The service and the middleware meet only through the `AuthService`
 * interface, which has no events. A service made by `createAuthService`
 * registers its revocations here; any other implementation has none.
 */
const registry = new WeakMap<AuthService, Revocations>();

export function registerRevocations(service: AuthService, revocations: Revocations): void {
  registry.set(service, revocations);
}

export function revocationsOf(service: AuthService): Revocations | undefined {
  return registry.get(service);
}
