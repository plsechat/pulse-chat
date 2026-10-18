import { useSyncExternalStore } from 'react';

/**
 * One shared clock for relative timestamps ("4 min ago"): every
 * subscriber re-renders on the same minute tick instead of each row
 * running its own interval. The timer only runs while someone listens.
 */
const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
};

const getNow = () => now;

/** Milliseconds since epoch, refreshed once a minute while mounted. */
const useNow = () => useSyncExternalStore(subscribe, getNow, getNow);

export { useNow };
