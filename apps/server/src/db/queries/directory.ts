import type { TDirectoryEntry, TDirectorySort } from '../../types';
import { and, asc, desc, eq, ilike, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '..';
import { getOnlineUserIds } from '../../utils/ws-stats';
import {
  directoryCache,
  federationInstances,
  files,
  serverMembers,
  servers
} from '../schema';

/**
 * Public directory — the local listed servers and the cached listings
 * of federated peers, read as one list.
 *
 * A local server is listed only while it has an open join path: the
 * Directory card's Preview and Join reuse servers.preview /
 * servers.joinDiscover, which require `discoverable`, and both refuse a
 * server that is not accepting members. The same predicate decides what
 * /federation/directory offers peers, with `federatable` in place of
 * `discoverable` because a remote member joins through the federated
 * path. The opt-in route refuses the flag without those, and this
 * predicate hides a server whose owner later closed the path instead
 * of showing a card whose buttons fail.
 */

/** Rows a peer gets per listing request — and the most we store per peer. */
const DIRECTORY_PEER_LIMIT = 200;
/** Rows one Directory page may ask for. */
const DIRECTORY_PAGE_MAX = 100;
/**
 * Each source is read in sorted order up to this many rows before the
 * two are merged, so a page at offset + limit ≤ this bound is exact.
 */
const DIRECTORY_SCAN_MAX = 1000;
/** Peer rows not refreshed in this long (the peer stopped answering) go. */
const DIRECTORY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const localListedPredicate = (joinPath: 'discoverable' | 'federatable') =>
  and(
    eq(servers.directoryListed, true),
    eq(servers.allowNewUsers, true),
    joinPath === 'discoverable'
      ? eq(servers.discoverable, true)
      : eq(servers.federatable, true)
  );

const memberCountOf = sql<number>`
  (SELECT count(*) FROM ${serverMembers}
    WHERE ${serverMembers.serverId} = ${servers.id})`;

/** Most online ids the subquery will carry; beyond that the count is capped. */
const ONLINE_IDS_MAX = 10_000;

/**
 * Members of the row's server with a live, visible socket right now.
 * The id list is spliced in as an array literal: handed to the template
 * as a value, a JS array is flattened into one parameter per element,
 * which breaks `= ANY($n::int[])` the moment a single user is online
 * (the unit tests run with nobody online and never saw it). The ids
 * come from this process's socket map, each checked to be an integer.
 */
const onlineCountOf = (onlineIds: number[]): SQL<number> => {
  const ids = onlineIds
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, ONLINE_IDS_MAX);

  if (ids.length === 0) {
    // Cast, not a bare literal: `ORDER BY 0` would be a column position.
    return sql<number>`0::int`;
  }

  return sql<number>`
  (SELECT count(*) FROM ${serverMembers}
    WHERE ${serverMembers.serverId} = ${servers.id}
      AND ${serverMembers.userId} = ANY(${sql.raw(`ARRAY[${ids.join(',')}]::int[]`)}))`;
};

const escapeLike = (value: string) => value.replace(/[%_\\]/g, '\\$&');

type TDirectoryListArgs = {
  userId: number;
  search?: string;
  game?: string;
  sort: TDirectorySort;
  limit: number;
  offset: number;
};

type TLocalRow = {
  serverId: number;
  publicId: string;
  name: string;
  description: string | null;
  tags: string[] | null;
  game: string | null;
  memberCount: number | string;
  onlineCount: number | string;
  logo: string | null;
  hasPassword: boolean;
  joined: boolean;
};

const toLocalEntry = (row: TLocalRow): TDirectoryEntry => ({
  source: 'local',
  serverId: row.serverId,
  publicId: row.publicId,
  name: row.name,
  description: row.description,
  tags: row.tags ?? [],
  game: row.game,
  memberCount: Number(row.memberCount),
  onlineCount: Number(row.onlineCount),
  logo: row.logo,
  hasPassword: row.hasPassword,
  joined: row.joined === true,
  instance: null,
  fetchedAt: null
});

const compareEntries =
  (sort: TDirectorySort) =>
  (a: TDirectoryEntry, b: TDirectoryEntry): number => {
    if (sort === 'name') return a.name.localeCompare(b.name) || a.publicId.localeCompare(b.publicId);
    const primary =
      sort === 'online'
        ? b.onlineCount - a.onlineCount || b.memberCount - a.memberCount
        : b.memberCount - a.memberCount || b.onlineCount - a.onlineCount;
    return primary || a.name.localeCompare(b.name) || a.publicId.localeCompare(b.publicId);
  };

/**
 * The Directory page: local listed servers and every peer's cached
 * listing, filtered and sorted together. Search is a bounded ILIKE over
 * name, game and the tags (the jsonb cast to text); the game filter is
 * an exact, case-insensitive match. Each source is read already sorted
 * and capped at DIRECTORY_SCAN_MAX, so the merge is exact for any page
 * inside that bound (the route caps offset + limit to it).
 */
const listDirectory = async (
  args: TDirectoryListArgs
): Promise<{ entries: TDirectoryEntry[]; hasMore: boolean }> => {
  const pattern = args.search ? `%${escapeLike(args.search)}%` : undefined;
  const game = args.game?.toLowerCase();

  const localWhere: SQL[] = [localListedPredicate('discoverable')!];
  const cacheWhere: SQL[] = [eq(federationInstances.status, 'active')];

  if (pattern) {
    localWhere.push(
      or(
        ilike(servers.name, pattern),
        ilike(servers.directoryGame, pattern),
        ilike(sql`${servers.directoryTags}::text`, pattern)
      )!
    );
    cacheWhere.push(
      or(
        ilike(directoryCache.name, pattern),
        ilike(directoryCache.game, pattern),
        ilike(sql`${directoryCache.tags}::text`, pattern)
      )!
    );
  }

  if (game) {
    localWhere.push(eq(sql`lower(${servers.directoryGame})`, game));
    cacheWhere.push(eq(sql`lower(${directoryCache.game})`, game));
  }

  const onlineIds = getOnlineUserIds();
  const localOnline = onlineCountOf(onlineIds);

  const localOrder =
    args.sort === 'name'
      ? [asc(servers.name), asc(servers.publicId)]
      : args.sort === 'online'
        ? [desc(localOnline), desc(memberCountOf), asc(servers.name)]
        : [desc(memberCountOf), desc(localOnline), asc(servers.name)];

  const cacheOrder =
    args.sort === 'name'
      ? [asc(directoryCache.name), asc(directoryCache.serverPublicId)]
      : args.sort === 'online'
        ? [desc(directoryCache.onlineCount), desc(directoryCache.memberCount), asc(directoryCache.name)]
        : [desc(directoryCache.memberCount), desc(directoryCache.onlineCount), asc(directoryCache.name)];

  const [localRows, cacheRows] = await Promise.all([
    db
      .select({
        serverId: servers.id,
        publicId: servers.publicId,
        name: servers.name,
        description: servers.directoryDescription,
        tags: servers.directoryTags,
        game: servers.directoryGame,
        memberCount: memberCountOf,
        onlineCount: localOnline,
        logo: files.name,
        hasPassword: sql<boolean>`coalesce(${servers.password}, '') <> ''`,
        joined: sql<boolean>`
          EXISTS (SELECT 1 FROM ${serverMembers}
            WHERE ${serverMembers.serverId} = ${servers.id}
              AND ${serverMembers.userId} = ${args.userId})`
      })
      .from(servers)
      .leftJoin(files, eq(servers.logoId, files.id))
      .where(and(...localWhere))
      .orderBy(...localOrder)
      .limit(DIRECTORY_SCAN_MAX),
    db
      .select({
        instanceId: federationInstances.id,
        instanceDomain: federationInstances.domain,
        instanceName: federationInstances.name,
        publicId: directoryCache.serverPublicId,
        name: directoryCache.name,
        description: directoryCache.description,
        tags: directoryCache.tags,
        game: directoryCache.game,
        memberCount: directoryCache.memberCount,
        onlineCount: directoryCache.onlineCount,
        logo: directoryCache.logoUrl,
        hasPassword: directoryCache.hasPassword,
        fetchedAt: directoryCache.fetchedAt
      })
      .from(directoryCache)
      .innerJoin(
        federationInstances,
        eq(directoryCache.instanceId, federationInstances.id)
      )
      .where(and(...cacheWhere))
      .orderBy(...cacheOrder)
      .limit(DIRECTORY_SCAN_MAX)
  ]);

  const merged: TDirectoryEntry[] = [
    ...localRows.map(toLocalEntry),
    ...cacheRows.map(
      (row): TDirectoryEntry => ({
        source: 'federated',
        serverId: null,
        publicId: row.publicId,
        name: row.name,
        description: row.description,
        tags: row.tags ?? [],
        game: row.game,
        memberCount: row.memberCount,
        onlineCount: row.onlineCount,
        logo: row.logo,
        hasPassword: row.hasPassword,
        joined: false,
        instance: {
          id: row.instanceId,
          domain: row.instanceDomain,
          name: row.instanceName || row.instanceDomain
        },
        fetchedAt: row.fetchedAt
      })
    )
  ].sort(compareEntries(args.sort));

  const page = merged.slice(args.offset, args.offset + args.limit);
  return { entries: page, hasMore: merged.length > args.offset + args.limit };
};

/**
 * Every distinct game named by a visible listing, for the filter.
 * Case-insensitive distinct (the first spelling seen wins), bounded.
 */
const listDirectoryGames = async (): Promise<string[]> => {
  const [localGames, cacheGames] = await Promise.all([
    db
      .selectDistinct({ game: servers.directoryGame })
      .from(servers)
      .where(
        and(localListedPredicate('discoverable'), sql`${servers.directoryGame} IS NOT NULL`)
      )
      .orderBy(asc(servers.directoryGame))
      .limit(DIRECTORY_PAGE_MAX),
    db
      .selectDistinct({ game: directoryCache.game })
      .from(directoryCache)
      .innerJoin(
        federationInstances,
        eq(directoryCache.instanceId, federationInstances.id)
      )
      .where(
        and(
          eq(federationInstances.status, 'active'),
          sql`${directoryCache.game} IS NOT NULL`
        )
      )
      .orderBy(asc(directoryCache.game))
      .limit(DIRECTORY_PAGE_MAX)
  ]);

  const seen = new Map<string, string>();
  for (const row of [...localGames, ...cacheGames]) {
    const game = row.game?.trim();
    if (!game) continue;
    const key = game.toLowerCase();
    if (!seen.has(key)) seen.set(key, game);
  }
  return [...seen.values()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, DIRECTORY_PAGE_MAX);
};

/** What a peer receives from /federation/directory. */
type TDirectoryPeerRow = {
  publicId: string;
  name: string;
  description: string | null;
  tags: string[];
  game: string | null;
  memberCount: number;
  onlineCount: number;
  logo: string | null;
  hasPassword: boolean;
};

/**
 * This instance's listing as offered to peers: listed, accepting
 * members and federatable (a remote member joins through
 * servers.joinFederated, which requires it). Largest communities first
 * so a peer that caps its pull keeps the ones worth showing.
 */
const listDirectoryForPeers = async (
  limit: number = DIRECTORY_PEER_LIMIT
): Promise<TDirectoryPeerRow[]> => {
  const online = onlineCountOf(getOnlineUserIds());
  const rows = await db
    .select({
      publicId: servers.publicId,
      name: servers.name,
      description: servers.directoryDescription,
      tags: servers.directoryTags,
      game: servers.directoryGame,
      memberCount: memberCountOf,
      onlineCount: online,
      logo: files.name,
      hasPassword: sql<boolean>`coalesce(${servers.password}, '') <> ''`
    })
    .from(servers)
    .leftJoin(files, eq(servers.logoId, files.id))
    .where(localListedPredicate('federatable'))
    .orderBy(desc(memberCountOf), asc(servers.name))
    .limit(Math.min(Math.max(1, limit), DIRECTORY_PEER_LIMIT));

  return rows.map((row) => ({
    publicId: row.publicId,
    name: row.name,
    description: row.description,
    tags: row.tags ?? [],
    game: row.game,
    memberCount: Number(row.memberCount),
    onlineCount: Number(row.onlineCount),
    logo: row.logo,
    hasPassword: row.hasPassword
  }));
};

/** A peer's row as the sync stores it (already bounded by the puller). */
type TDirectoryCacheRow = {
  serverPublicId: string;
  name: string;
  description: string | null;
  tags: string[];
  game: string | null;
  memberCount: number;
  onlineCount: number;
  logoUrl: string | null;
  hasPassword: boolean;
};

/**
 * Replace a peer's cached listing: upsert every row the peer sent with
 * `fetchedAt = now`, then drop the peer's rows it no longer lists.
 * Returns what changed for the cron log.
 */
const replaceDirectoryCache = async (
  instanceId: number,
  rows: TDirectoryCacheRow[],
  now: number
): Promise<{ upserted: number; removed: number }> => {
  const kept = rows.slice(0, DIRECTORY_PEER_LIMIT);

  if (kept.length > 0) {
    await db
      .insert(directoryCache)
      .values(kept.map((row) => ({ ...row, instanceId, fetchedAt: now })))
      .onConflictDoUpdate({
        target: [directoryCache.instanceId, directoryCache.serverPublicId],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          tags: sql`excluded.tags`,
          game: sql`excluded.game`,
          memberCount: sql`excluded.member_count`,
          onlineCount: sql`excluded.online_count`,
          logoUrl: sql`excluded.logo_url`,
          hasPassword: sql`excluded.has_password`,
          fetchedAt: sql`excluded.fetched_at`
        }
      });
  }

  const removed = await db
    .delete(directoryCache)
    .where(
      kept.length === 0
        ? eq(directoryCache.instanceId, instanceId)
        : and(
            eq(directoryCache.instanceId, instanceId),
            notInArray(
              directoryCache.serverPublicId,
              kept.map((row) => row.serverPublicId)
            )
          )
    )
    .returning({ id: directoryCache.id });

  return { upserted: kept.length, removed: removed.length };
};

/**
 * The hourly refresh: new counts for rows already cached, and the rows
 * the peer delisted go. Nothing is added and `fetchedAt` stays — a new
 * listing arrives with the daily pull, which is what the card's
 * staleness means.
 */
const refreshDirectoryCacheCounts = async (
  instanceId: number,
  rows: TDirectoryCacheRow[]
): Promise<{ updated: number; removed: number }> => {
  const kept = rows.slice(0, DIRECTORY_PEER_LIMIT);
  const known = await db
    .select({ serverPublicId: directoryCache.serverPublicId })
    .from(directoryCache)
    .where(eq(directoryCache.instanceId, instanceId));
  const knownIds = new Set(known.map((row) => row.serverPublicId));

  let updated = 0;
  for (const row of kept) {
    if (!knownIds.has(row.serverPublicId)) continue;
    await db
      .update(directoryCache)
      .set({
        memberCount: row.memberCount,
        onlineCount: row.onlineCount,
        hasPassword: row.hasPassword
      })
      .where(
        and(
          eq(directoryCache.instanceId, instanceId),
          eq(directoryCache.serverPublicId, row.serverPublicId)
        )
      );
    updated += 1;
  }

  const listed = new Set(kept.map((row) => row.serverPublicId));
  const delisted = [...knownIds].filter((id) => !listed.has(id));
  if (delisted.length === 0) return { updated, removed: 0 };

  const removed = await db
    .delete(directoryCache)
    .where(
      and(
        eq(directoryCache.instanceId, instanceId),
        inArray(directoryCache.serverPublicId, delisted)
      )
    )
    .returning({ id: directoryCache.id });

  return { updated, removed: removed.length };
};

/** Every cached row of one peer — on block/unpeer (a removed peer cascades). */
const pruneDirectoryCacheForInstance = async (
  instanceId: number
): Promise<number> => {
  const removed = await db
    .delete(directoryCache)
    .where(eq(directoryCache.instanceId, instanceId))
    .returning({ id: directoryCache.id });
  return removed.length;
};

/** Rows no pull has refreshed within the max age: the peer went quiet. */
const pruneStaleDirectoryCache = async (now: number): Promise<number> => {
  const removed = await db
    .delete(directoryCache)
    .where(lt(directoryCache.fetchedAt, now - DIRECTORY_CACHE_MAX_AGE_MS))
    .returning({ id: directoryCache.id });
  return removed.length;
};

export {
  DIRECTORY_CACHE_MAX_AGE_MS,
  DIRECTORY_PAGE_MAX,
  DIRECTORY_PEER_LIMIT,
  DIRECTORY_SCAN_MAX,
  listDirectory,
  listDirectoryForPeers,
  listDirectoryGames,
  pruneDirectoryCacheForInstance,
  pruneStaleDirectoryCache,
  refreshDirectoryCacheCounts,
  replaceDirectoryCache,
  type TDirectoryCacheRow,
  type TDirectoryPeerRow
};
