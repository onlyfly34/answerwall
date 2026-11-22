// The fuses of a packaged Electron executable: switches compiled into the
// binary that turn features of Electron off for good. They sit in the
// executable as a marker followed by one byte for the format version, one
// for the number of fuses and then one byte per fuse: '0' off, '1' on, 'r'
// removed. (https://www.electronjs.org/docs/latest/tutorial/fuses)
//
// electron-builder writes them when it packages (scripts/package.mjs). This
// module reads them back, so that verify-package can check what is shipped,
// and changes one in a copy that is only tested (scripts/enable-inspector.mjs).
// No dependencies.

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const WIRE_VERSION = 1;

/** The fuses of wire version 1, in the order of their bytes. */
export const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
];

const STATES = new Map([
  [0x30, 'off'],
  [0x31, 'on'],
  [0x72, 'removed'],
]);

/** Where the fuse bytes start, for every copy of the marker (a universal binary has two). */
function wires(buffer) {
  const found = [];
  for (let at = buffer.indexOf(SENTINEL); at !== -1; at = buffer.indexOf(SENTINEL, at + 1)) {
    const version = buffer[at + SENTINEL.length];
    const count = buffer[at + SENTINEL.length + 1];
    if (version !== WIRE_VERSION) throw new Error(`Unknown fuse format version ${version}`);
    if (count === undefined || count < FUSE_NAMES.length) {
      throw new Error(`The executable has ${count} fuses, expected at least ${FUSE_NAMES.length}`);
    }
    found.push(at + SENTINEL.length + 2);
  }
  return found;
}

/** Whether these bytes are an Electron executable with fuses. */
export function hasFuses(buffer) {
  return buffer.includes(SENTINEL);
}

/**
 * The state of every known fuse: 'on', 'off' or 'removed'.
 * @throws Error when the bytes hold no fuses, or copies of them that differ
 */
export function readFuses(buffer) {
  const starts = wires(buffer);
  if (starts.length === 0) throw new Error('No fuses found: not an Electron executable');
  const read = (start) =>
    Object.fromEntries(
      FUSE_NAMES.map((name, index) => {
        const state = STATES.get(buffer[start + index]);
        if (state === undefined) throw new Error(`The fuse ${name} has an unknown state`);
        return [name, state];
      }),
    );
  const first = read(starts[0]);
  for (const start of starts.slice(1)) {
    if (JSON.stringify(read(start)) !== JSON.stringify(first)) {
      throw new Error('The copies of the fuses in the executable differ');
    }
  }
  return first;
}

/**
 * Switches one fuse on or off, in place.
 * @throws Error for an unknown fuse or one that was removed from the binary
 */
export function setFuse(buffer, name, on) {
  const index = FUSE_NAMES.indexOf(name);
  if (index === -1) throw new Error(`Unknown fuse ${name}`);
  if (readFuses(buffer)[name] === 'removed') throw new Error(`The fuse ${name} was removed`);
  for (const start of wires(buffer)) buffer[start + index] = on ? 0x31 : 0x30;
}
