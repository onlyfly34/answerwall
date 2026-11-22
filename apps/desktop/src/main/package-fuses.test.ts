import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { FUSE_NAMES, hasFuses, readFuses, setFuse } from '../../scripts/fuses.mjs';

/** An executable's bytes around its fuses: '1' on, '0' off, 'r' removed. */
const executable = (states: string, version = 1): Buffer =>
  Buffer.concat([
    Buffer.from('MZ\0\0 machine code '),
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([version, states.length]),
    Buffer.from(states),
    Buffer.from(' more machine code'),
  ]);

describe('the fuses of a packaged executable', () => {
  test('are read in the order Electron defines', () => {
    expect(readFuses(executable('1100110r'))).toEqual({
      runAsNode: 'on',
      enableCookieEncryption: 'on',
      enableNodeOptionsEnvironmentVariable: 'off',
      enableNodeCliInspectArguments: 'off',
      enableEmbeddedAsarIntegrityValidation: 'on',
      onlyLoadAppFromAsar: 'on',
      loadBrowserProcessSpecificV8Snapshot: 'off',
      grantFileProtocolExtraPrivileges: 'removed',
    });
  });

  test('fuses a newer Electron added after these are left alone', () => {
    const newer = executable('1100110010');
    setFuse(newer, 'enableNodeCliInspectArguments', true);
    expect(newer.subarray(-28).toString()).toBe('1101110010 more machine code');
  });

  test('one fuse is switched and nothing else changes', () => {
    const buffer = executable('11001100');
    const before = Buffer.from(buffer);

    setFuse(buffer, 'enableNodeCliInspectArguments', true);

    expect(readFuses(buffer)).toEqual({
      ...readFuses(before),
      enableNodeCliInspectArguments: 'on',
    });
    const changed = [...buffer.keys()].filter((index) => buffer[index] !== before[index]);
    expect(changed).toHaveLength(1);

    setFuse(buffer, 'enableNodeCliInspectArguments', false);
    expect(buffer.equals(before)).toBe(true);
  });

  test('both copies in a universal binary are switched together', () => {
    const buffer = Buffer.concat([executable('11001100'), executable('11001100')]);
    setFuse(buffer, 'runAsNode', false);
    expect(readFuses(buffer)['runAsNode']).toBe('off');
    expect(buffer.toString('latin1').match(/01001100/g)).toHaveLength(2);
  });

  test.each([
    ['bytes without fuses', Buffer.from('#!/bin/sh\necho hello\n')],
    ['another format version', executable('11001100', 2)],
    ['too few fuses', executable('1100')],
    ['a state that is none', executable('1100x100')],
    ['copies that differ', Buffer.concat([executable('11001100'), executable('11011100')])],
  ])('%s is refused', (_what, buffer) => {
    expect(() => readFuses(buffer)).toThrow();
    expect(() => setFuse(buffer, 'runAsNode', true)).toThrow();
  });

  test('an unknown or removed fuse cannot be switched', () => {
    expect(() => setFuse(executable('11001100'), 'enableEverything', true)).toThrow();
    expect(() =>
      setFuse(executable('1100110r'), 'grantFileProtocolExtraPrivileges', true),
    ).toThrow();
  });

  test('tells an Electron executable from any other file', () => {
    expect(hasFuses(executable('11001100'))).toBe(true);
    expect(hasFuses(Buffer.from('plain text'))).toBe(false);
  });
});

describe('what is shipped', () => {
  const read = (name: string): string =>
    readFileSync(new URL(`../../scripts/${name}`, import.meta.url), 'utf8');

  test('the package is built with the inspector switched off', () => {
    const fuses = /electronFuses: \{([^}]+)\}/.exec(read('package.mjs'))?.[1] ?? '';
    const setting = (name: string): string | undefined =>
      new RegExp(`^\\s*${name}: (true|false),$`, 'm').exec(fuses)?.[1];

    expect(setting('enableNodeCliInspectArguments')).toBe('false');
    expect(setting('enableNodeOptionsEnvironmentVariable')).toBe('false');
    expect(setting('onlyLoadAppFromAsar')).toBe('true');
    expect(setting('enableEmbeddedAsarIntegrityValidation')).toBe('true');
    expect(setting('grantFileProtocolExtraPrivileges')).toBe('false');
    // Every fuse the build sets is one this module can read back.
    for (const name of fuses.matchAll(/^\s*(\w+): (?:true|false),$/gm)) {
      expect(FUSE_NAMES).toContain(name[1]);
    }
  });

  test('verify-package checks the fuses of the executable it is given', () => {
    const verify = read('verify-package.mjs');
    expect(verify).toContain("enableNodeCliInspectArguments: 'off'");
    expect(verify).toContain('readFuses');
  });
});
