/**
 * Whether the page is in the foreground, and a signal that it may be worth
 * trying the network again (the page became visible, or the device came back
 * online). Phones suspend background pages and silently drop their
 * connections, so the stream uses this to pause and to resume promptly.
 */
export interface Visibility {
  hidden(): boolean;
  /** Calls `listener` on every visibility or connectivity change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export const pageVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  subscribe(listener) {
    document.addEventListener('visibilitychange', listener);
    window.addEventListener('online', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
      window.removeEventListener('online', listener);
    };
  },
};
