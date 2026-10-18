import { publishGamePresence } from '../db/publishers';
import { getStoredGamePresence, setGamePresence } from '../db/queries/game-presence';
import { logger } from '../logger';
import { relayGamePresence } from './federation-game-presence-dispatch';

/**
 * Game presence lifecycle around the stored value (db/queries/
 * game-presence.ts): the per-user report budget, the fan-out after a
 * change, and the clear that follows a user's last socket.
 */

/** A user may change what they are playing at most once per window. */
const GAME_PRESENCE_MIN_INTERVAL_MS = 10_000;
const lastAcceptedAt = new Map<number, number>();

// Bounded: a user's stamp is dropped once it can no longer block a
// report, so the map never outgrows the users who reported recently.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [userId, at] of lastAcceptedAt) {
    if (now - at >= GAME_PRESENCE_MIN_INTERVAL_MS) lastAcceptedAt.delete(userId);
  }
}, 60_000);
pruneTimer.unref();

/**
 * Admit or refuse a report. Only an admitted report stamps the window:
 * a refused one must not push the next admission further out, or a
 * shell flapping between two games could lock itself out for good.
 */
const checkGamePresenceRateLimit = (
  userId: number,
  now: number = Date.now()
): { allowed: true } | { allowed: false; retryAfterMs: number } => {
  const last = lastAcceptedAt.get(userId);
  if (last !== undefined && now - last < GAME_PRESENCE_MIN_INTERVAL_MS) {
    return { allowed: false, retryAfterMs: GAME_PRESENCE_MIN_INTERVAL_MS - (now - last) };
  }
  lastAcceptedAt.set(userId, now);
  return { allowed: true };
};

/** The stored value changed: tell every roster here, then the peers. */
const announceGamePresence = async (userId: number): Promise<void> => {
  await publishGamePresence(userId);
  void relayGamePresence(userId);
};

/**
 * The sharing rule changed (master switch or hidden list). Off clears
 * the stored game — a value nobody may see must not sit on the row
 * waiting for the switch to come back on with a stale "for N min". On
 * re-evaluates every roster: a hidden community clears, an un-hidden
 * one shows. Nothing is announced when there was nothing to show.
 */
const reconcileGamePresenceWithPreference = async (
  userId: number,
  shareGame: boolean
): Promise<void> => {
  const outcome = shareGame
    ? { changed: false, presence: await getStoredGamePresence(userId) }
    : await setGamePresence(userId, null);
  if (outcome.changed || outcome.presence) await announceGamePresence(userId);
};

// ─── Last socket closed ──────────────────────────────────────────────────
//
// The shell that reported the game is gone with the session (sign-out,
// a closed app, a crash): the presence goes with it. Debounced like the
// federation offline push, so a page refresh does not clear and
// re-announce; when the user is back inside the window nothing happens
// (the shell re-reports on connect anyway, and a same-name report keeps
// the original startedAt).

const GAME_PRESENCE_CLEAR_DEBOUNCE_MS = 5_000;
let clearDebounceMs = GAME_PRESENCE_CLEAR_DEBOUNCE_MS;
const pendingClears = new Map<number, ReturnType<typeof setTimeout>>();

const scheduleGamePresenceClear = (
  userId: number,
  stillConnected: () => boolean
): void => {
  const existing = pendingClears.get(userId);
  if (existing !== undefined) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingClears.delete(userId);
    if (stillConnected()) return;
    void (async () => {
      try {
        const { changed } = await setGamePresence(userId, null);
        if (changed) await announceGamePresence(userId);
      } catch (err) {
        logger.error('[game-presence] clear after disconnect failed for %d: %o', userId, err);
      }
    })();
  }, clearDebounceMs);
  pendingClears.set(userId, timer);
};

/** Test-only: shorten the disconnect debounce; `undefined` restores it. */
const _setGamePresenceClearDebounceForTests = (ms: number | undefined): void => {
  clearDebounceMs = ms ?? GAME_PRESENCE_CLEAR_DEBOUNCE_MS;
};

/** Test-only: forget every report window. */
const _resetGamePresenceRateLimitForTests = (): void => {
  lastAcceptedAt.clear();
};

export {
  _resetGamePresenceRateLimitForTests,
  _setGamePresenceClearDebounceForTests,
  announceGamePresence,
  checkGamePresenceRateLimit,
  GAME_PRESENCE_MIN_INTERVAL_MS,
  reconcileGamePresenceWithPreference,
  scheduleGamePresenceClear
};
