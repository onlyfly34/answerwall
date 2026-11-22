// For the suites that start the mock CLIs: which of the processes recorded in
// a `MOCK_CLI_LOG` file are still running, and how to end one of them.
//
// A process id alone does not say that. Windows gives the number of an ended
// process to one of the next that start, so on a busy machine a mock's old
// number soon belongs to a browser, a server or a mock of another test.
// Asking "is this number alive" then reports a leftover that is none, and
// ending "it" ends a stranger with everything below it. A recorded process is
// therefore still running only if a process with its number exists that was
// created before the record was written: nothing else can have had the number
// at that moment.
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Every process the mocks recorded in `logFile`, their own and their
 * children's, as `{ pid, at }`: the number, and when it was written down
 * (the latest time, for a number that was recorded more than once).
 */
export function recordedProcesses(logFile) {
  let text;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  const latest = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line);
    const at = typeof entry.at === 'number' ? entry.at : Date.now();
    for (const pid of [entry.pid, entry.grandchildPid]) {
      if (typeof pid === 'number') latest.set(pid, Math.max(at, latest.get(pid) ?? 0));
    }
  }
  return [...latest].map(([pid, at]) => ({ pid, at }));
}

/** Whether any process has this number right now. A Linux zombie does not count. */
export function processExists(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  try {
    const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return status.charAt(status.lastIndexOf(')') + 2) !== 'Z';
  } catch {
    return false;
  }
}

/** When the processes with these numbers were created, in milliseconds since the epoch (Windows). */
function creationTimes(pids) {
  const filter = pids.map((pid) => `ProcessId=${Number(pid)}`).join(' OR ');
  // No double quote anywhere: the command travels as one argument.
  const command =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
    "'{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 60_000 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`The running processes could not be listed: ${error.message}`));
          return;
        }
        const created = new Map();
        for (const line of stdout.split(/\r?\n/)) {
          const match = /^(\d+) (-?\d+)$/.exec(line.trim());
          if (match) created.set(Number(match[1]), Number(match[2]));
        }
        resolve(created);
      },
    );
  });
}

/**
 * The numbers of those recorded processes that are still running.
 *
 * Only Windows needs the second look. Linux counts its process ids upwards
 * and starts again only after the highest one, so a number does not come back
 * while one of these suites runs.
 */
export async function runningProcesses(records) {
  const candidates = records.filter((record) => processExists(record.pid));
  if (candidates.length === 0 || process.platform !== 'win32') {
    return candidates.map((record) => record.pid);
  }
  const created = await creationTimes(candidates.map((record) => record.pid));
  return candidates
    .filter((record) => {
      const since = created.get(record.pid);
      return since !== undefined && since <= record.at;
    })
    .map((record) => record.pid);
}

/** Ends a process and everything it started. Only for a number `runningProcesses` returned. */
export function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone in the meantime.
    }
  }
}
