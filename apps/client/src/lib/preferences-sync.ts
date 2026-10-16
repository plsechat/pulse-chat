import type { TUserPreferences } from '@pulse/shared';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type TPendingPreferences = DeepPartial<TUserPreferences>;

/**
 * Batches preference writes to the server. Nothing queued here is ever
 * dropped: a flush that finds no home client or fails re-queues its
 * payload under anything queued since (newer keys win) and re-arms the
 * timer, and `applyServerPreferences` replays the queue over the server
 * copy on the next join so a change made offline is not reverted by the
 * stale server values.
 */
let pendingUpdate: TPendingPreferences = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let debounceMs = 1000;
let retryMs = 5000;
// The home client is reached through a dynamic import at flush time, not
// a static one: a static edge closes the cycle preference-store →
// preferences-sync → lib/trpc → features/app/actions → … → the hooks that
// create preference stores at module top level, and whichever module the
// graph is entered from then sees a binding still in its temporal dead
// zone (observed as "Cannot access 'createPreferenceStore' before
// initialization" when a test loaded this side first). The type is
// taken from the module without importing it at runtime.
type HomeClient = ReturnType<typeof import('@/lib/trpc').getHomeTRPCClient>;
type ClientResolver = () => HomeClient | Promise<HomeClient>;
let clientOverride: ClientResolver | null = null;
const resolveClient: ClientResolver = () =>
  clientOverride
    ? clientOverride()
    : import('@/lib/trpc').then((m) => m.getHomeTRPCClient());

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) ?? {},
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const mergePending = (base: TPendingPreferences, over: TPendingPreferences) =>
  deepMerge(
    base as Record<string, unknown>,
    over as Record<string, unknown>
  ) as TPendingPreferences;

const hasPending = () => Object.keys(pendingUpdate).length > 0;

const armTimer = (delay: number) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flush();
  }, delay);
};

/** Put a failed payload back under whatever was queued meanwhile. */
const requeue = (update: TPendingPreferences) => {
  pendingUpdate = mergePending(update, pendingUpdate);
  armTimer(retryMs);
};

const flush = async (): Promise<void> => {
  if (inFlight) return inFlight;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!hasPending()) return;

  const update = pendingUpdate;
  pendingUpdate = {};

  // inFlight is set before the first await so a second flush that lands
  // while the client is still being resolved joins this one instead of
  // racing it.
  inFlight = (async () => {
    const trpc = await resolveClient();
    if (!trpc) {
      requeue(update);
      return;
    }
    try {
      await trpc.users.updatePreferences.mutate(
        update as Parameters<typeof trpc.users.updatePreferences.mutate>[0]
      );
    } catch {
      requeue(update);
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
};

/**
 * Queue a partial preference update. Multiple calls within the debounce
 * window are batched into a single server request.
 */
export const syncPreference = (partial: TPendingPreferences) => {
  pendingUpdate = mergePending(pendingUpdate, partial);
  armTimer(debounceMs);
};

/** Send whatever is queued now (page unload, server copy just applied). */
export const flushPreferencesNow = () => flush();

/** Queued-but-unsent preferences, so a server copy can be overlaid. */
export const getPendingPreferences = (): TPendingPreferences => pendingUpdate;

// A closing tab has no later chance to retry: push the queue now. The WS
// frame leaves synchronously, so the server usually still receives it.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void flushPreferencesNow();
  });
}

export const __testing = {
  deepMerge,
  /** Swap the client lookup (null = disconnected). */
  setClientResolver(resolver: ClientResolver | null) {
    clientOverride = resolver;
  },
  setDelays(next: { debounceMs?: number; retryMs?: number }) {
    if (next.debounceMs !== undefined) debounceMs = next.debounceMs;
    if (next.retryMs !== undefined) retryMs = next.retryMs;
  },
  reset() {
    pendingUpdate = {};
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    inFlight = null;
    debounceMs = 1000;
    retryMs = 5000;
    clientOverride = null;
  },
  hasTimer: () => debounceTimer !== null
};
