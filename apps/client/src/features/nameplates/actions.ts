import { store } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { nameplatesSliceActions } from './slice';

/**
 * Load the active server's custom nameplate packs. Called from
 * fetchDeferredServerData with the just-joined server's trpc client
 * (home or remote) and its publicId for staleness guarding — same
 * contract as the deferred emoji fetch.
 */
export const fetchNameplates = (
  trpc: ReturnType<typeof getTRPCClient>,
  expectedServerId: string
) => {
  if (!trpc) return;

  // Clear the previous server's packs immediately — pack ids are
  // instance-local, so a co-member's 'custom:<id>' must never resolve
  // against another server's list while the fetch is in flight.
  store.dispatch(nameplatesSliceActions.resetState());

  trpc.nameplates.getAll.query().then((packs) => {
    if (store.getState().server.serverId !== expectedServerId) return;
    store.dispatch(nameplatesSliceActions.setPacks(packs));
  }).catch((err) => console.error('Failed to fetch nameplates:', err));
};

/** Re-fetch packs for the currently active server (admin add/delete). */
export const refreshNameplates = () => {
  const serverId = store.getState().server.serverId;
  if (!serverId) return;
  fetchNameplates(getTRPCClient(), serverId);
};
