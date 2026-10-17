import { DEFAULT_USER_PREFERENCES, type TUserPreferences } from '@pulse/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '..';
import type { TGamePresence } from '../../types';
import { serverMembers, servers, userPreferences, users } from '../schema';

/**
 * Game presence: what a member is playing, reported by their desktop
 * shell (docs/desktop-integration.md). The row holds one value; who
 * gets to see it is decided per server, here, from the user's
 * `preferences.presence` — `shareGame` is the master switch and
 * `hiddenServers` the per-community opt-out. For a federated shadow the
 * home instance's decision arrives with the relay as a list of OUR
 * servers' publicIds, which the receiver mirrors onto the shadow's
 * preferences row as local ids (mirrorShadowPresencePreference), so one
 * rule serves local users and shadows alike.
 */

/** A session older than this is cleared by the cron: a shell that crashed never leaves a ghost. */
const GAME_PRESENCE_TTL_MS = 6 * 60 * 60 * 1000;
/** Longest game name accepted from the shell or a peer. */
const GAME_PRESENCE_MAX_NAME_LENGTH = 64;
/** Most communities one user can hide the presence from. */
const MAX_HIDDEN_SERVERS = 200;
/** `domain:publicId` — a 253-char host, the colon, a 64-char publicId. */
const MAX_HIDDEN_SERVER_KEY_LENGTH = 253 + 1 + 64;

type TPresencePreference = TUserPreferences['presence'];

/** Server-side default for rows written before the preference existed. */
const normalizePresencePreference = (
  data: Partial<TUserPreferences> | undefined
): TPresencePreference => ({
  shareGame: data?.presence?.shareGame === true,
  hiddenServers: Array.isArray(data?.presence?.hiddenServers)
    ? data.presence.hiddenServers
    : []
});

const getPresencePreferences = async (
  userIds: number[]
): Promise<Map<number, TPresencePreference>> => {
  const result = new Map<number, TPresencePreference>();
  if (userIds.length === 0) return result;

  const rows = await db
    .select({ userId: userPreferences.userId, data: userPreferences.data })
    .from(userPreferences)
    .where(inArray(userPreferences.userId, [...new Set(userIds)]));

  for (const row of rows) {
    result.set(row.userId, normalizePresencePreference(row.data));
  }
  for (const id of userIds) {
    if (!result.has(id)) {
      result.set(id, normalizePresencePreference(undefined));
    }
  }
  return result;
};

/**
 * The presence as `serverId`'s roster may show it: null unless the user
 * shares it at all and has not hidden this server. Only the two public
 * fields cross — nothing else on the row is a roster's business.
 */
const visibleGamePresence = (
  presence: TGamePresence | null | undefined,
  prefs: TPresencePreference,
  serverId: number
): TGamePresence | null => {
  if (!presence || !prefs.shareGame) return null;
  if (prefs.hiddenServers.includes(serverId)) return null;
  return { name: presence.name, startedAt: presence.startedAt };
};

/**
 * Apply the per-server rule to a roster: every row gets a `gamePresence`
 * (null when nothing may show), so the client can tell "not playing"
 * from "this projection did not say". Preferences are loaded only for
 * the members that have a presence at all — usually a handful.
 */
const attachGamePresenceForServer = async <
  T extends { id: number; gamePresence: TGamePresence | null }
>(
  serverId: number,
  rows: T[]
): Promise<Array<Omit<T, 'gamePresence'> & { gamePresence: TGamePresence | null }>> => {
  const playingIds = rows.filter((r) => r.gamePresence).map((r) => r.id);
  const prefs = await getPresencePreferences(playingIds);

  return rows.map((row) => ({
    ...row,
    gamePresence: row.gamePresence
      ? visibleGamePresence(row.gamePresence, prefs.get(row.id)!, serverId)
      : null
  }));
};

const getStoredGamePresence = async (
  userId: number
): Promise<TGamePresence | null> => {
  const [row] = await db
    .select({ gamePresence: users.gamePresence })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.gamePresence ?? null;
};

/**
 * Store what the user is playing (or null). Reporting the same game
 * again keeps the original `startedAt` — the shell re-sends on every
 * reconnect and "for N min" must not restart with the socket. Returns
 * whether anything changed, so a no-op report fans nothing out.
 */
const setGamePresence = async (
  userId: number,
  name: string | null,
  now: number = Date.now()
): Promise<{ changed: boolean; presence: TGamePresence | null }> => {
  const [row] = await db
    .select({ gamePresence: users.gamePresence })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const current = row?.gamePresence ?? null;

  if (name === null) {
    if (!current) return { changed: false, presence: null };
    await db
      .update(users)
      .set({ gamePresence: null, updatedAt: now })
      .where(eq(users.id, userId));
    return { changed: true, presence: null };
  }

  if (current && current.name === name) {
    return { changed: false, presence: current };
  }

  const presence = { name, startedAt: now };
  await db
    .update(users)
    .set({ gamePresence: presence, updatedAt: now })
    .where(eq(users.id, userId));
  return { changed: true, presence };
};

/**
 * Everything the fan-out needs for one user: the stored presence, the
 * sharing rule, and the servers (id + publicId) the user is a member of.
 */
const getGamePresenceState = async (userId: number) => {
  const [[row], prefsMap, memberships] = await Promise.all([
    db
      .select({
        gamePresence: users.gamePresence,
        isFederated: users.isFederated
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    getPresencePreferences([userId]),
    db
      .select({ id: servers.id, publicId: servers.publicId })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, userId))
  ]);

  return {
    presence: row?.gamePresence ?? null,
    isFederated: row?.isFederated ?? false,
    prefs: prefsMap.get(userId)!,
    servers: memberships
  };
};

/**
 * The cron's sweep: clear every presence whose session started more
 * than `ttlMs` before `now` and return the users it cleared, so the
 * caller can fan the change out. One statement — the set of rows with a
 * presence at all is tiny next to the users table.
 */
const expireStaleGamePresence = async (
  now: number = Date.now(),
  ttlMs: number = GAME_PRESENCE_TTL_MS
): Promise<number[]> => {
  const cutoff = now - ttlMs;
  const cleared = await db
    .update(users)
    .set({ gamePresence: null, updatedAt: now })
    .where(
      and(
        isNotNull(users.gamePresence),
        sql`(${users.gamePresence}->>'startedAt')::bigint < ${cutoff}`
      )
    )
    .returning({ id: users.id });
  return cleared.map((r) => r.id);
};

/**
 * A peer told us which of OUR servers its user hides the presence from
 * (by publicId). Store the decision on the shadow's preferences row as
 * local server ids, so the roster rule above reads shadows and local
 * users the same way. Unknown publicIds are dropped (not our servers).
 */
const mirrorShadowPresencePreference = async (
  shadowUserId: number,
  hiddenServerPublicIds: string[]
): Promise<void> => {
  const ids =
    hiddenServerPublicIds.length === 0
      ? []
      : (
          await db
            .select({ id: servers.id })
            .from(servers)
            .where(inArray(servers.publicId, hiddenServerPublicIds))
        ).map((r) => r.id);

  const [existing] = await db
    .select({ data: userPreferences.data })
    .from(userPreferences)
    .where(eq(userPreferences.userId, shadowUserId))
    .limit(1);

  const data: TUserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    ...existing?.data,
    presence: { shareGame: true, hiddenServers: ids }
  };
  const now = Date.now();

  await db
    .insert(userPreferences)
    .values({ userId: shadowUserId, data, updatedAt: now })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { data, updatedAt: now }
    });
};

export {
  attachGamePresenceForServer,
  expireStaleGamePresence,
  GAME_PRESENCE_MAX_NAME_LENGTH,
  GAME_PRESENCE_TTL_MS,
  getGamePresenceState,
  getPresencePreferences,
  getStoredGamePresence,
  MAX_HIDDEN_SERVER_KEY_LENGTH,
  MAX_HIDDEN_SERVERS,
  mirrorShadowPresencePreference,
  normalizePresencePreference,
  setGamePresence,
  visibleGamePresence
};
export type { TPresencePreference };
