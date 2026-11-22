import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Device, PairingCodeResponse } from '@answerwall/core/protocol';
import type { ApiClient } from '../contracts/services.ts';

/** The paired devices and the pairing code most recently created on this page. */
export interface DevicesStore {
  /** `undefined` until loaded. */
  devices: Accessor<Device[] | undefined>;
  maxDevices: Accessor<number | undefined>;
  pairingCode: Accessor<PairingCodeResponse | undefined>;
  load: () => Promise<void>;
  revoke: (deviceId: string) => Promise<void>;
  createPairingCode: () => Promise<void>;
}

export function createDevicesStore(
  api: Pick<ApiClient, 'listDevices' | 'revokeDevice' | 'createPairingCode'>,
): DevicesStore {
  const [devices, setDevices] = createSignal<Device[]>();
  const [maxDevices, setMaxDevices] = createSignal<number>();
  const [pairingCode, setPairingCode] = createSignal<PairingCodeResponse>();

  async function load(): Promise<void> {
    const response = await api.listDevices();
    setDevices(response.devices);
    setMaxDevices(response.maxDevices);
  }

  return {
    devices,
    maxDevices,
    pairingCode,
    load,
    async revoke(deviceId) {
      await api.revokeDevice(deviceId);
      setDevices((list) => list?.filter((device) => device.id !== deviceId));
    },
    async createPairingCode() {
      setPairingCode(await api.createPairingCode());
    },
  };
}
