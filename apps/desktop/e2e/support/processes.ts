/** Looking at the system's process list, to prove what is and is not running. */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

async function linuxProcesses(): Promise<ProcessInfo[]> {
  const found: ProcessInfo[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      // A zombie has an empty command line; it is no longer running.
      if (raw !== '') found.push({ pid: Number(entry), commandLine: raw.replaceAll('\0', ' ') });
    } catch {
      // Gone while listing.
    }
  }
  return found;
}

async function windowsProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  const rows = JSON.parse(stdout) as { ProcessId: number; CommandLine: string | null }[];
  return rows
    .filter((row) => row.CommandLine !== null)
    .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine ?? '' }));
}

/** Every process whose command line contains `text`, this test process aside. */
export async function processesMentioning(text: string): Promise<ProcessInfo[]> {
  const all = process.platform === 'win32' ? await windowsProcesses() : await linuxProcesses();
  return all.filter(
    (candidate) => candidate.pid !== process.pid && candidate.commandLine.includes(text),
  );
}

/** Ends a process without giving it a chance to react, and nothing below it. */
export async function killHard(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/F', '/PID', String(pid)], { windowsHide: true });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

/** Ends a process and everything it started; for cleaning up after a failed expectation. */
export async function killTree(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await run('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}
