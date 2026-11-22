/** A process a mock CLI recorded: its number, and when that was written down. */
export interface RecordedProcess {
  pid: number;
  /** Milliseconds since the epoch. */
  at: number;
}

/** Every process the mocks recorded in `logFile`, their own and their children's. */
export function recordedProcesses(logFile: string): RecordedProcess[];

/** Whether any process has this number right now. A Linux zombie does not count. */
export function processExists(pid: number): boolean;

/**
 * The numbers of those recorded processes that are still running. On Windows
 * a number that was given to another process in the meantime is left out.
 */
export function runningProcesses(records: readonly RecordedProcess[]): Promise<number[]>;

/** Ends a process and everything it started. Only for a number `runningProcesses` returned. */
export function killProcessTree(pid: number): void;
