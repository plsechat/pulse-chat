import type { TGamePresence } from '@pulse/server/types';

/**
 * The desktop bridge for game presence. The shell detects the game
 * (docs/desktop-integration.md — `window.pulseDesktop.onGamePresence`);
 * this module turns its callbacks into `users.setGamePresence` reports
 * to the HOME instance and keeps the one copy of "what I am playing"
 * that the client's own surfaces read (Home greeting). Nothing here
 * runs unless `startGamePresenceBridge` is called, which the React hook
 * does only while "share what you're playing" is on.
 *
 * Reports are coalesced to the server's budget (one per 10 s per user):
 * a shell flapping between two games sends the LAST state when the
 * window reopens, never a burst, and a report refused mid-window is
 * not a lost state. The reported game is re-sent when the home session
 * reopens — the server clears the presence with the last socket, and a
 * same-name report keeps the original startedAt there.
 */

type TShellPresence = { name: string } | null;

const REPORT_MIN_INTERVAL_MS = 10_000;

type HomeClient = ReturnType<typeof import('@/lib/trpc').getHomeTRPCClient>;
type ClientResolver = () => HomeClient | Promise<HomeClient>;
// Dynamic by default for the same reason preferences-sync resolves its
// client late: a static edge to lib/trpc closes an import cycle through
// features/app/actions.
let clientOverride: ClientResolver | null = null;
const resolveClient: ClientResolver = () =>
  clientOverride
    ? clientOverride()
    : import('@/lib/trpc').then((m) => m.getHomeTRPCClient());

let minIntervalMs = REPORT_MIN_INTERVAL_MS;

// ─── Own presence (what the local surfaces show) ─────────────────────────

let ownPresence: TGamePresence | null = null;
let listeners: Array<() => void> = [];

const notify = () => {
  for (const listener of listeners) listener();
};

const setOwnPresence = (next: TShellPresence) => {
  const before = ownPresence;
  if (next === null) {
    ownPresence = null;
  } else if (before && before.name === next.name) {
    // Same game re-reported: the session did not restart.
    return;
  } else {
    ownPresence = { name: next.name, startedAt: Date.now() };
  }
  if (before !== ownPresence) notify();
};

export const getOwnGamePresence = (): TGamePresence | null => ownPresence;

export const subscribeOwnGamePresence = (listener: () => void): (() => void) => {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
};

// ─── Reporting (coalesced) ───────────────────────────────────────────────

let lastSentAt = 0;
let pending: TShellPresence | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

const send = async (presence: TShellPresence): Promise<void> => {
  lastSentAt = Date.now();
  try {
    const trpc = await resolveClient();
    if (!trpc) return;
    await trpc.users.setGamePresence.mutate(presence ? { name: presence.name } : null);
  } catch {
    // A refused or failed report is superseded by the next one (and the
    // server clears a presence with the last socket); nothing to retry.
  }
};

/** Report `presence`, now if the window allows, else as the last state when it reopens. */
const report = (presence: TShellPresence): void => {
  const elapsed = Date.now() - lastSentAt;
  if (timer === null && elapsed >= minIntervalMs) {
    void send(presence);
    return;
  }
  pending = presence;
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = undefined;
      if (next !== undefined) void send(next);
    }, Math.max(0, minIntervalMs - elapsed));
  }
};

// ─── Shell subscription ──────────────────────────────────────────────────

let unsubscribeShell: (() => void) | null = null;

const onShellPresence = (presence: TShellPresence): void => {
  const next = presence && presence.name.trim() ? { name: presence.name.trim() } : null;
  setOwnPresence(next);
  report(next);
};

/**
 * Subscribe to the shell's detection. Returns false when there is no
 * shell (or an older one without the hook) — the browser build has
 * nothing to report. Idempotent.
 */
export const startGamePresenceBridge = (): boolean => {
  if (unsubscribeShell) return true;
  const subscribe = window.pulseDesktop?.onGamePresence;
  if (typeof subscribe !== 'function') return false;
  unsubscribeShell = subscribe(onShellPresence);
  return true;
};

/**
 * Stop listening and report "nothing" — the switch went off, or the
 * surface that owned the bridge is gone (sign-out). The report takes the
 * coalesced path like any other, so a game that closed inside the window
 * still clears when it reopens.
 */
export const stopGamePresenceBridge = (): void => {
  if (unsubscribeShell) {
    unsubscribeShell();
    unsubscribeShell = null;
  }
  if (ownPresence !== null || pending !== undefined) {
    setOwnPresence(null);
    report(null);
  }
};

/**
 * The home session reopened: the server dropped the presence with the
 * old socket (after its debounce), so what the shell last reported is
 * reported again. A same-name report keeps the original startedAt.
 */
export const resendGamePresence = (): void => {
  if (!unsubscribeShell || ownPresence === null) return;
  report({ name: ownPresence.name });
};

export const __testing = {
  setClientResolver(resolver: ClientResolver | null) {
    clientOverride = resolver;
  },
  setMinInterval(ms: number) {
    minIntervalMs = ms;
  },
  reset() {
    if (unsubscribeShell) {
      unsubscribeShell();
      unsubscribeShell = null;
    }
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = undefined;
    lastSentAt = 0;
    ownPresence = null;
    listeners = [];
    minIntervalMs = REPORT_MIN_INTERVAL_MS;
  }
};
