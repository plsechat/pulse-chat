import type { TUserPreferences } from '@pulse/shared';
import { getHomeTRPCClient } from '@/lib/trpc';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

let pendingUpdate: DeepPartial<TUserPreferences> = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 1000;

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

const flush = async () => {
  const update = pendingUpdate;
  pendingUpdate = {};
  debounceTimer = null;

  try {
    const trpc = getHomeTRPCClient();
    await trpc.users.updatePreferences.mutate(update as Parameters<typeof trpc.users.updatePreferences.mutate>[0]);
  } catch {
    // Silent failure — localStorage is the immediate cache,
    // preferences will re-sync on next successful call
  }
};

/**
 * Queue a partial preference update. Multiple calls within DEBOUNCE_MS
 * are batched into a single server request.
 */
export const syncPreference = (partial: DeepPartial<TUserPreferences>) => {
  pendingUpdate = deepMerge(
    pendingUpdate as Record<string, unknown>,
    partial as Record<string, unknown>
  ) as DeepPartial<TUserPreferences>;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
};
