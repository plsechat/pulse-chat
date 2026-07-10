/**
 * In-memory cache of banned user ids — read-side fast path for the
 * tRPC auth middleware.
 *
 * Why this exists
 * ===============
 * The auth middleware ran `getUserById(ctx.userId)` on every protected
 * procedure call to re-check the banned flag. tRPC over WS calls
 * createContext per-request, so the per-context user cache in
 * `wss.ts` doesn't deduplicate across calls. On initial connect the
 * client fires ~40+ subscriptions/queries simultaneously, each
 * paying one round-trip to a (potentially remote) Postgres. On
 * deployments where the DB is on a separate host, this multiplied
 * the loading-screen UX by RTT × 40 — observed at 30+ seconds on
 * chat2 (high-RTT link).
 *
 * Design
 * ======
 * - Boot-time `loadBannedUsersCache()` reads every row where
 *   `users.banned = true` and fills a module-scoped `Set<number>`.
 * - `isBanned(userId)` is a sync `Set.has` call — zero DB roundtrip.
 * - `markBanned(userId)` / `markUnbanned(userId)` are called by the
 *   ban / unban mutations after their DB writes commit. The set
 *   reflects the new state immediately for every connection on this
 *   process.
 * - Multi-process deployments (we're not there yet, but if we ever
 *   shard) would need a pubsub-backed invalidation. Single-process is
 *   fine for now.
 *
 * Trade-off
 * =========
 * If a row in `users.banned` is mutated outside the ban / unban
 * routes (e.g. a manual SQL UPDATE), this cache won't see it until
 * the next process restart. Acceptable: the codebase has exactly
 * two places that flip the flag, both wired below.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { logger } from '../logger';

const bannedUserIds = new Set<number>();

let isLoaded = false;

/**
 * Populate the cache from the database. Must be called once at boot,
 * after `loadDb()`. Idempotent — repeated calls re-scan the table
 * (useful for tests).
 */
export async function loadBannedUsersCache(): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.banned, true));

  bannedUserIds.clear();
  for (const row of rows) bannedUserIds.add(row.id);
  isLoaded = true;

  logger.debug('[bannedCache] loaded %d banned user(s)', bannedUserIds.size);
}

/**
 * O(1) sync lookup. Safe to call before `loadBannedUsersCache()` —
 * returns `false` for any unknown user. Production startup wires the
 * loader before the HTTP/WS server accepts traffic, so the
 * "unloaded but called" window doesn't exist outside tests.
 */
export function isBanned(userId: number): boolean {
  return bannedUserIds.has(userId);
}

/**
 * Mark a user as banned. Called by the ban mutation after the DB
 * write commits. Idempotent.
 */
export function markBanned(userId: number): void {
  bannedUserIds.add(userId);
  logger.debug('[bannedCache] marked banned userId=%d', userId);
}

/**
 * Mark a user as unbanned. Called by the unban mutation after the DB
 * write commits. Idempotent.
 */
export function markUnbanned(userId: number): void {
  bannedUserIds.delete(userId);
  logger.debug('[bannedCache] marked unbanned userId=%d', userId);
}

/**
 * Test-only — reset internal state so test files start with a clean
 * cache. Not exported via the public surface; only consumed by the
 * test in `__tests__/banned-cache.test.ts`.
 */
export function _resetBannedCacheForTest(): void {
  bannedUserIds.clear();
  isLoaded = false;
}

/** Test-only — inspect whether the cache has been loaded. */
export function _isBannedCacheLoaded(): boolean {
  return isLoaded;
}

/** Test-only — read the current size. */
export function _bannedCacheSize(): number {
  return bannedUserIds.size;
}
