import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock, IdGenerator, RandomSource } from './contracts/index.ts';

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export const randomIds: IdGenerator = { next: () => randomUUID() };

export const systemRandom: RandomSource = { bytes: (length) => randomBytes(length) };
