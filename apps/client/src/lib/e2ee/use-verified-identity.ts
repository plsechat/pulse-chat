/**
 * Read-side hook for the Phase C verifiedIdentities store.
 *
 * Returns the pinned record for `userId` from the *currently active*
 * SignalProtocolStore (home or federated, depending on which server
 * is in focus), or null if no entry exists, or `undefined` while
 * loading. The active-store scoping matters because user IDs are
 * per-instance — home userId 5 is not the same person as federated
 * userId 5 — so badges and verification status must always be
 * resolved against the same store the active server uses for its
 * own E2EE flows.
 *
 * Refreshes when `notifyVerifiedIdentityChanged()` fires — call that
 * after any deliberate write (mark-verified, accept-change, clear-pin)
 * so badges re-render across the app. Silent TOFU pinning during
 * session establishment doesn't fire it; the next mount will pick it
 * up.
 */

import { activeInstanceDomainSelector } from '@/features/app/selectors';
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { getStoreForInstance, type VerifiedIdentityRecord } from './store';

const listeners = new Set<() => void>();

export function notifyVerifiedIdentityChanged(): void {
  for (const cb of listeners) cb();
}

export function useVerifiedIdentity(
  userId: number | null | undefined
): VerifiedIdentityRecord | null | undefined {
  const activeDomain = useSelector(activeInstanceDomainSelector);
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
    const store = getStoreForInstance(activeDomain);
    store
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
  }, [userId, tick, activeDomain]);

  return data;
}
