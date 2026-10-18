import type { TUpcomingEvent } from '@pulse/server/types';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * The Home overview's "Upcoming events": one list across every home
 * community, from `events.upcomingForUser`. It is fetched when the
 * overview comes on screen and again when an event changes anywhere
 * the home socket can hear (create, update, delete, signups) — never
 * on a timer. The planner's per-server slice is not reused: it holds
 * one server's window, keyed by the server in focus, and Home has none.
 */

type TUpcomingState = {
  items: TUpcomingEvent[];
  /** The home user the list was fetched for; another account's list is stale. */
  forUserId: number | undefined;
  loaded: boolean;
};

type HomeClient = ReturnType<typeof import('@/lib/trpc').getHomeTRPCClient>;
type ClientResolver = () => HomeClient | Promise<HomeClient>;
// Resolved late, like lib/game-presence: a static edge to lib/trpc from
// a module the screens import closes an import cycle through
// features/app/actions, and the test injects a fake this way.
let clientOverride: ClientResolver | null = null;
const resolveClient: ClientResolver = () =>
  clientOverride
    ? clientOverride()
    : import('@/lib/trpc').then((m) => m.getHomeTRPCClient());

const EMPTY: TUpcomingState = { items: [], forUserId: undefined, loaded: false };

let state: TUpcomingState = EMPTY;
const listeners = new Set<() => void>();

const setState = (next: TUpcomingState) => {
  state = next;
  listeners.forEach((l) => l());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getState = () => state;

let inflight: Promise<void> | null = null;
let lastUserId: number | undefined;

/** Loads the list for `userId` once; a second call while one is in flight joins it. */
export const fetchUpcomingEvents = (userId: number | undefined): Promise<void> => {
  if (inflight) return inflight;
  lastUserId = userId;
  inflight = (async () => {
    try {
      const trpc = await resolveClient();
      if (!trpc) return;
      const items = await trpc.events.upcomingForUser.query();
      setState({ items, forUserId: userId, loaded: true });
    } catch (err) {
      // The previous list stays; the next change or mount fetches again.
      console.warn('Failed to fetch upcoming events:', err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
};

/**
 * An event changed somewhere: refetch while the overview is on screen,
 * else drop the cached list so the next mount fetches fresh.
 */
export const refreshUpcomingEvents = () => {
  if (listeners.size > 0) {
    void fetchUpcomingEvents(lastUserId);
  } else if (state.loaded) {
    setState(EMPTY);
  }
};

/**
 * The list for the signed-in home user, fetched on mount; `loaded` is
 * false until the first response for that account arrived.
 */
export const useUpcomingEvents = (
  homeUserId: number | undefined
): { items: TUpcomingEvent[]; loaded: boolean } => {
  const snapshot = useSyncExternalStore(subscribe, getState, getState);
  useEffect(() => {
    void fetchUpcomingEvents(homeUserId);
  }, [homeUserId]);
  const current = snapshot.loaded && snapshot.forUserId === homeUserId;
  return { items: current ? snapshot.items : [], loaded: current };
};

/** Test-only. */
export const __testing = {
  setClientResolver(resolver: ClientResolver | null) {
    clientOverride = resolver;
  },
  subscribe,
  snapshot: getState,
  reset() {
    inflight = null;
    lastUserId = undefined;
    state = EMPTY;
    listeners.clear();
    clientOverride = null;
  }
};
