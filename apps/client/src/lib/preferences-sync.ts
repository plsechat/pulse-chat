import type { TUserPreferences } from '@pulse/shared';
import { getHomeTRPCClient } from '@/lib/trpc';

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
// Resolved at call time, never captured at module evaluation: this module
// sits inside the @/lib/trpc → features/app/actions → … → preferences-sync
// → @/lib/trpc cycle, and getHomeTRPCClient is a const binding in trpc.ts
// that is still in its temporal dead zone when the graph is entered from
// the trpc side.
type ClientResolver = () => ReturnType<typeof getHomeTRPCClient>;
let clientOverride: ClientResolver | null = null;
const resolveClient: ClientResolver = () =>
  (clientOverride ?? getHomeTRPCClient)();

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

  const trpc = resolveClient();
  if (!trpc) {
    requeue(update);
    return;
  }

  inFlight = trpc.users.updatePreferences
    .mutate(update as Parameters<typeof trpc.users.updatePreferences.mutate>[0])
    .then(
      () => undefined,
      () => {
        requeue(update);
      }
    )
    .finally(() => {
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
