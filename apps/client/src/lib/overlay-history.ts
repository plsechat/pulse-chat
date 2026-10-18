/**
 * Browser-history integration for in-app overlays (the mobile drawers,
 * bottom sheets, the full-screen thread panel). Each open overlay pushes
 * one history entry, so the platform back gesture — Android Back, the
 * iOS edge swipe, the browser's Back button — closes the overlay instead
 * of leaving the app. An overlay closed through its own UI pops its
 * entry again, so Back afterwards still means "leave" as it should.
 *
 * Overlays stack (drawer → sheet): Back closes the most recent one.
 * The history object is injectable for tests; the browser's is used by
 * default and the popstate listener is installed on first use.
 */

type THistoryLike = {
  pushState: (state: unknown) => void;
  back: () => void;
};

type TEntry = {
  id: number;
  close: () => void;
};

const stack: TEntry[] = [];
let nextId = 1;
let listening = false;
/** popstate events caused by our own history.back() — not a user Back. */
let selfPops = 0;

let history: THistoryLike = {
  pushState: (state) => window.history.pushState(state, ''),
  back: () => window.history.back()
};

const handlePopState = () => {
  if (selfPops > 0) {
    selfPops -= 1;
    return;
  }
  const top = stack.pop();
  if (top) top.close();
};

const ensureListener = () => {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('popstate', handlePopState);
};

/** Register an open overlay. Returns the id to release when it closes. */
const pushOverlay = (close: () => void): number => {
  ensureListener();
  const id = nextId++;
  stack.push({ id, close });
  history.pushState({ pulseOverlay: id });
  return id;
};

/**
 * The overlay closed on its own (tap outside, X, selection). Drop its
 * entry; when it was the newest one, drop its history entry too. An
 * unknown id (already popped by Back) is a no-op.
 */
const releaseOverlay = (id: number) => {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  const wasTop = index === stack.length - 1;
  stack.splice(index, 1);
  if (wasTop) {
    selfPops += 1;
    history.back();
  }
};

const __testing = {
  handlePopState,
  setHistory: (next: THistoryLike) => {
    history = next;
  },
  reset: () => {
    stack.length = 0;
    selfPops = 0;
    nextId = 1;
  },
  depth: () => stack.length
};

export { __testing, pushOverlay, releaseOverlay };
