import { useEffect } from 'react';

/**
 * Keep the screen on while `active` (countdown and Round). The browser drops the lock when the page is
 * hidden, so it is re-acquired on `visibilitychange`. Silently does nothing where unsupported.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let pending = false;
    let stopped = false;

    const acquire = async () => {
      if (stopped || pending || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      pending = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (stopped) void s.release().catch(() => undefined);
        else sentinel = s;
      } catch {
        // Denied (battery saver, not visible): the Round still works, the screen may just dim.
      } finally {
        pending = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}
