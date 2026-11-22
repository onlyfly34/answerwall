export type FuseState = 'on' | 'off' | 'removed';

export const FUSE_NAMES: readonly string[];
export function hasFuses(buffer: Buffer): boolean;
export function readFuses(buffer: Buffer): Record<string, FuseState>;
export function setFuse(buffer: Buffer, name: string, on: boolean): void;
