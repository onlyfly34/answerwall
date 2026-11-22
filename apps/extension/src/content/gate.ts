/**
 * The one condition under which the content script does anything: its frame
 * sits directly under a top-level page of this very extension. In an
 * ordinary tab, under a web page, under another extension, or nested deeper,
 * it returns before touching the page.
 */
export interface FramePosition {
  self: unknown;
  parent: unknown;
  top: unknown;
  /** `location.ancestorOrigins`: the origins of the frames above, nearest first. */
  ancestorOrigins: ArrayLike<string>;
  /** `chrome.runtime.id` */
  extensionId: string;
}

export function isUnderWall(position: FramePosition): boolean {
  return (
    position.top !== position.self &&
    position.parent === position.top &&
    position.ancestorOrigins.length === 1 &&
    position.ancestorOrigins[0] === `chrome-extension://${position.extensionId}`
  );
}
