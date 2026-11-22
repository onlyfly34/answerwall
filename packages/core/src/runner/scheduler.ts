/** A slot's place at its provider: first in the queue, then holding one of the provider's permits. */
export interface Ticket {
  /** Still in the queue. */
  readonly waiting: boolean;
  /** Leaves the queue, or returns the permit and admits whoever is next. Idempotent. */
  release(): void;
}

interface Waiter {
  askId: string;
  state: 'waiting' | 'running' | 'released';
  start: () => void;
}

interface Gate {
  waiting: Waiter[];
  active: number;
  /** Per ask that still has waiters here: the admission counter value when it was last served. */
  lastServed: Map<string, number>;
  admissions: number;
}

/**
 * One counting semaphore per provider instance. Nothing runs beyond the
 * provider's capacity, which is read again on every admission so a changed
 * setting takes effect at once (a lowered one as running slots finish).
 *
 * Within one ask slots are admitted first in, first out. Between asks the
 * permits rotate: the next permit goes to the ask that was served least
 * recently, so a large ask cannot keep a later, small one waiting behind all
 * of its slots.
 */
export class Scheduler {
  private readonly capacityOf: (providerId: string) => number;
  private readonly gates = new Map<string, Gate>();
  private waitingTotal = 0;

  constructor(capacityOf: (providerId: string) => number) {
    this.capacityOf = capacityOf;
  }

  /** Slots waiting for a permit, over all providers. */
  get waitingCount(): number {
    return this.waitingTotal;
  }

  /** Slots holding a permit of this provider. */
  activeCount(providerId: string): number {
    return this.gates.get(providerId)?.active ?? 0;
  }

  /** How many more slots this provider would admit right now. */
  freePermits(providerId: string): number {
    const gate = this.gates.get(providerId);
    if (!gate) return Math.max(0, this.capacityOf(providerId));
    if (gate.waiting.length > 0) return 0;
    return Math.max(0, this.capacityOf(providerId) - gate.active);
  }

  /**
   * Joins the provider's queue. `start` is called, synchronously from
   * {@link dispatch} or from another ticket's release, when a permit is granted.
   */
  enqueue(providerId: string, askId: string, start: () => void): Ticket {
    let gate = this.gates.get(providerId);
    if (!gate) {
      gate = { waiting: [], active: 0, lastServed: new Map(), admissions: 0 };
      this.gates.set(providerId, gate);
    }
    const owner = gate;
    const waiter: Waiter = { askId, state: 'waiting', start };
    owner.waiting.push(waiter);
    this.waitingTotal++;
    return {
      get waiting() {
        return waiter.state === 'waiting';
      },
      release: () => {
        if (waiter.state === 'waiting') {
          owner.waiting.splice(owner.waiting.indexOf(waiter), 1);
          this.waitingTotal--;
          this.forgetIfServed(owner, askId);
        } else if (waiter.state === 'running') {
          owner.active--;
        }
        const wasRunning = waiter.state === 'running';
        waiter.state = 'released';
        if (wasRunning) this.dispatch(providerId);
        else this.discardIfIdle(providerId, owner);
      },
    };
  }

  /** Grants free permits of one provider, or of all of them. */
  dispatch(providerId?: string): void {
    for (const id of providerId === undefined ? [...this.gates.keys()] : [providerId]) {
      const gate = this.gates.get(id);
      if (!gate) continue;
      while (gate.waiting.length > 0 && gate.active < this.capacityOf(id)) {
        const [waiter] = gate.waiting.splice(this.nextIndex(gate), 1);
        if (!waiter) break;
        waiter.state = 'running';
        gate.active++;
        this.waitingTotal--;
        gate.lastServed.set(waiter.askId, ++gate.admissions);
        this.forgetIfServed(gate, waiter.askId);
        waiter.start();
      }
      this.discardIfIdle(id, gate);
    }
  }

  /** The waiter of the least recently served ask; the earliest one among equals. */
  private nextIndex(gate: Gate): number {
    let best = 0;
    let bestServed = Infinity;
    gate.waiting.forEach((waiter, index) => {
      const served = gate.lastServed.get(waiter.askId) ?? 0;
      if (served < bestServed) {
        best = index;
        bestServed = served;
      }
    });
    return best;
  }

  /** Rotation state is only needed while the ask still has waiters at this gate. */
  private forgetIfServed(gate: Gate, askId: string): void {
    if (!gate.waiting.some((waiter) => waiter.askId === askId)) gate.lastServed.delete(askId);
  }

  private discardIfIdle(providerId: string, gate: Gate): void {
    if (gate.active === 0 && gate.waiting.length === 0 && this.gates.get(providerId) === gate) {
      this.gates.delete(providerId);
    }
  }
}
