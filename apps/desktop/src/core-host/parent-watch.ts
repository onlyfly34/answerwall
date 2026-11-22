/**
 * Notices that the main process is gone. A utility process normally ends
 * with the main process by itself; where it does not (seen on Windows while
 * children were running), the core host must not stay behind holding the
 * port and the data directory.
 *
 * Two signs, because the first alone can be fooled:
 *
 * 1. Every {@link PARENT_CHECK_MS}: the process that started this one no
 *    longer exists, or (POSIX) another process has adopted this one.
 * 2. Windows never re-parents, and gives the id of a process that ended to a
 *    new one. If that happens to the main process's id between two checks,
 *    sign 1 says "exists" for as long as that unrelated process lives. So
 *    the main process also sends a message every few seconds. Their absence
 *    alone proves nothing (the main process can be busy for a long time, in
 *    a menu or a window drag), but it is the occasion to look closer: is
 *    the process with that id still the one it was at start? Only a changed
 *    identity counts as "gone".
 *
 * Where the system cannot tell processes with the same id apart, sign 2 is
 * never raised, and the watch is as good as sign 1.
 */

/** How often the host looks whether the main process still exists. */
export const PARENT_CHECK_MS = 2_000;
/** After this many checks in a row without a message, and again after as many more, the identity is compared. */
export const SILENT_CHECKS = 5;

export interface ParentWatchDeps {
  /** The id of the process this one belongs to, as the system sees it now. */
  parentPid(): number;
  /** Whether a process with this id exists. */
  exists(pid: number): boolean;
  /**
   * What tells the process with this id apart from any other that ever had
   * or will have the same id: its creation time. `undefined` where that
   * cannot be had; rejections count the same.
   */
  identify(pid: number): Promise<string | undefined>;
  /** Runs `task` every `ms`, without keeping the process alive for it. */
  every(ms: number, task: () => void): () => void;
}

export interface ParentWatch {
  /** The main process has just sent something: it is alive. */
  heard(): void;
}

/** Calls `gone` once, when the main process no longer exists. */
export function watchParentProcess(deps: ParentWatchDeps, gone: () => void): ParentWatch {
  const parent = deps.parentPid();
  let identity: string | undefined;
  void deps.identify(parent).then(
    (value) => {
      identity = value;
    },
    () => undefined,
  );

  /** Whether the main process sends messages at all; one that never did is not judged by them. */
  let beating = false;
  let silent = 0;
  let comparing = false;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    stop();
    gone();
  };

  const stop = deps.every(PARENT_CHECK_MS, () => {
    if (finished) return;
    let exists: boolean;
    try {
      // Adopted by another process: the one that started this one has ended.
      exists = deps.parentPid() === parent && deps.exists(parent);
    } catch {
      exists = true;
    }
    if (!exists) {
      finish();
      return;
    }
    if (!beating) return;
    silent += 1;
    if (silent % SILENT_CHECKS !== 0 || identity === undefined || comparing) return;
    comparing = true;
    void deps.identify(parent).then(
      (now) => {
        comparing = false;
        // Unknown is not "another process": only a different identity is.
        if (now !== undefined && now !== identity) finish();
      },
      () => {
        comparing = false;
      },
    );
  });

  return {
    heard() {
      beating = true;
      silent = 0;
    },
  };
}
