/**
 * The reaper: a helper process of the core host that ends the CLI children
 * when the host dies without running any code of its own. That is how a
 * utility process ends when the app's main process is killed or crashes:
 * no exit handler runs, so nothing in the host could kill its children.
 *
 * The host writes one line per event to this process's stdin: `+<pid>` when
 * a CLI process tree starts, `-<pid>` when it has finished. When stdin ends
 * (the host is gone, however it went), every tree still registered is
 * killed and the reaper exits. It reads nothing else and never prints.
 *
 * Runs with plain Node semantics (the app's executable started with
 * ELECTRON_RUN_AS_NODE), as one self-contained CommonJS file.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const live = new Set<number>();
const LINE = /^([+-])(\d{1,10})$/;

function apply(line: string): void {
  const match = LINE.exec(line.trim());
  if (!match) return;
  const pid = Number(match[2]);
  // Never 0 or 1: a negative of those would address this process's own group or every process.
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (match[1] === '+') live.add(pid);
  else live.delete(pid);
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
    const taskkill = root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill';
    spawnSync(taskkill, ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    });
    return;
  }
  try {
    // Each CLI leads its own process group.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

let finished = false;
function finish(): void {
  if (finished) return;
  finished = true;
  for (const pid of live) killTree(pid);
  process.exit(0);
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text: string) => {
  buffered += text;
  let newline: number;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    apply(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
  }
});
process.stdin.on('end', finish);
process.stdin.on('close', finish);
process.stdin.on('error', finish);
