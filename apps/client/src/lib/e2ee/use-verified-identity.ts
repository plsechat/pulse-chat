/**
 * Read-side hook for the Phase C verifiedIdentities store.
 *
 * Returns the pinned record for `userId` from the home `signalStore`,
 * or null if no entry exists, or `undefined` while loading.
 *
 * Refreshes when `notifyVerifiedIdentityChanged()` fires — call that
 * after any deliberate write (mark-verified, accept-change, clear-pin)
 * so badges re-render across the app. Silent TOFU pinning during
 * session establishment doesn't fire it; the next mount will pick it
 * up.
 */

import { useEffect, useState } from 'react';
import { signalStore, type VerifiedIdentityRecord } from './store';

const listeners = new Set<() => void>();

export function notifyVerifiedIdentityChanged(): void {
  for (const cb of listeners) cb();
}

export function useVerifiedIdentity(
  userId: number | null | undefined
): VerifiedIdentityRecord | null | undefined {
  const [data, setData] = useState<
    VerifiedIdentityRecord | null | undefined
  >(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  useEffect(() => {
    if (userId == null) {
      setData(null);
      return;
    }
    let cancelled = false;
    signalStore
      .getVerifiedIdentity(userId)
      .then((r) => {
        if (!cancelled) setData(r ?? null);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, tick]);

  return data;
}
