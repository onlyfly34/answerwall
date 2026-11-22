// Makes a packaged application drivable by the end-to-end tests:
//
//   node scripts/enable-inspector.mjs [<executable>]
//
// Without an argument it takes E2E_APP_EXECUTABLE, the packaged application
// the tests are about to start.
//
// The tests drive the main process through Node's inspector, which the
// application as shipped refuses (the fuse enableNodeCliInspectArguments is
// off: scripts/package.mjs). This switches that one fuse on in the given
// executable, in place. It is for a copy that is tested and then thrown
// away: the unpacked application on Linux, the installed one on a CI runner.
// Never run it on anything that is published; the installer is not touched
// by it, and verify-package fails for an application it was used on.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readFuses, setFuse } from './fuses.mjs';

const FUSE = 'enableNodeCliInspectArguments';
const target = process.argv[2] ?? process.env['E2E_APP_EXECUTABLE'];
if (!target) {
  console.error('Usage: node scripts/enable-inspector.mjs <executable>, or set E2E_APP_EXECUTABLE');
  process.exit(2);
}
const file = path.resolve(target);
const buffer = readFileSync(file);
const before = readFuses(buffer)[FUSE];
setFuse(buffer, FUSE, true);
writeFileSync(file, buffer);
console.log(`${file}: ${FUSE} was ${before}, is now ${readFuses(readFileSync(file))[FUSE]}.`);
console.log('This copy is for testing only.');
