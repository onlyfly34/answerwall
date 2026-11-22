import { describe, expect, test } from 'vitest';
import { isUnderWall } from './gate.ts';

const ID = 'nffcmlcjkacklpololkpdmhcfokannom';
const WALL = `chrome-extension://${ID}`;

describe('where the content script is active', () => {
  const top = { name: 'top' };
  const self = { name: 'frame' };

  test('directly under a page of this extension', () => {
    expect(isUnderWall({ self, parent: top, top, ancestorOrigins: [WALL], extensionId: ID })).toBe(
      true,
    );
  });

  test('not in an ordinary tab of the site', () => {
    expect(
      isUnderWall({ self, parent: self, top: self, ancestorOrigins: [], extensionId: ID }),
    ).toBe(false);
  });

  test('not under a web page, whatever that page is', () => {
    for (const origin of ['https://evil.example', 'https://claude.ai', 'null']) {
      expect(
        isUnderWall({ self, parent: top, top, ancestorOrigins: [origin], extensionId: ID }),
      ).toBe(false);
    }
  });

  test('not under another extension', () => {
    expect(
      isUnderWall({
        self,
        parent: top,
        top,
        ancestorOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
        extensionId: ID,
      }),
    ).toBe(false);
  });

  test('not nested deeper: a frame of a frame, even when the top is the wall', () => {
    const middle = { name: 'middle' };
    expect(
      isUnderWall({
        self,
        parent: middle,
        top,
        ancestorOrigins: ['https://claude.ai', WALL],
        extensionId: ID,
      }),
    ).toBe(false);
    // The wall framed by something else is not a wall either.
    expect(
      isUnderWall({
        self,
        parent: top,
        top,
        ancestorOrigins: [WALL, 'https://evil.example'],
        extensionId: ID,
      }),
    ).toBe(false);
  });
});
