import {
  DIRECTORY_DESCRIPTION_MAX_LENGTH,
  DIRECTORY_GAME_MAX_LENGTH,
  DIRECTORY_TAG_MAX_LENGTH,
  DIRECTORY_TAGS_MAX
} from '@pulse/shared';
import {
  DIRECTORY_PEER_LIMIT,
  refreshDirectoryCacheCounts,
  replaceDirectoryCache,
  type TDirectoryCacheRow
} from '../db/queries/directory';
import {
  MAX_PEER_SERVER_NAME_LENGTH,
  isPeerPublicId,
  peerFileName,
  peerInteger,
  peerString,
  peerStringArray
} from '../http/federation-helpers';
import { logger } from '../logger';
import { config } from '../config';
import { queryInstance } from './federation';
import { getFederationProtocol } from './validate-url';

/**
 * Pulling a peer's directory listing into directory_cache.
 *
 * `full` (daily, and when a pairing becomes active) replaces the peer's
 * rows; `counts` (hourly) only refreshes member/online counts of rows
 * already cached and drops delisted ones. Both go through
 * `queryInstance` — signed request, signed response, hardened fetch —
 * and treat the peer's answer as untrusted: every field is bounded or
 * dropped before it reaches the table, and more than
 * DIRECTORY_PEER_LIMIT rows are cut.
 */

type TSyncMode = 'full' | 'counts';

type TPeerInstance = { id: number; domain: string };

/** A count a peer may claim; anything above is "not sent". */
const MAX_PEER_COUNT = 10_000_000;

/**
 * One peer-supplied listing row, bounded. Undefined when it lacks the
 * structural fields (a publicId and a name) — those rows are skipped
 * rather than stored half-empty.
 */
const boundPeerRow = (
  raw: unknown,
  instanceDomain: string
): TDirectoryCacheRow | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;

  if (!isPeerPublicId(row.publicId)) return undefined;
  const name = peerString(row.name, MAX_PEER_SERVER_NAME_LENGTH)?.trim();
  if (!name) return undefined;

  const logoName = peerFileName(row.logo);
  const logoUrl = logoName
    ? `${getFederationProtocol(instanceDomain)}://${instanceDomain}/public/${logoName}`
    : null;

  return {
    serverPublicId: row.publicId,
    name,
    description: peerString(row.description, DIRECTORY_DESCRIPTION_MAX_LENGTH) ?? null,
    tags: peerStringArray(row.tags, DIRECTORY_TAG_MAX_LENGTH, DIRECTORY_TAGS_MAX) ?? [],
    game: peerString(row.game, DIRECTORY_GAME_MAX_LENGTH) ?? null,
    memberCount: peerInteger(row.memberCount, { min: 0, max: MAX_PEER_COUNT }) ?? 0,
    onlineCount: peerInteger(row.onlineCount, { min: 0, max: MAX_PEER_COUNT }) ?? 0,
    logoUrl,
    hasPassword: row.hasPassword === true
  };
};

type TSyncOutcome =
  | { ok: true; rows: number; removed: number }
  | { ok: false; reason: 'unreachable' | 'malformed' };

/**
 * Pull one peer's listing. A peer that cannot be reached, answers a
 * bad signature or runs a release without the route leaves its cache
 * untouched — the daily stale prune handles a peer that stays silent.
 */
const syncDirectoryFromInstance = async (
  instance: TPeerInstance,
  mode: TSyncMode,
  now: number
): Promise<TSyncOutcome> => {
  const data = await queryInstance<{ servers?: unknown }>(
    instance.domain,
    '/federation/directory',
    { limit: DIRECTORY_PEER_LIMIT }
  );

  if (data === null) return { ok: false, reason: 'unreachable' };
  if (!Array.isArray(data.servers)) return { ok: false, reason: 'malformed' };

  const seen = new Set<string>();
  const rows: TDirectoryCacheRow[] = [];
  for (const raw of data.servers.slice(0, DIRECTORY_PEER_LIMIT)) {
    const row = boundPeerRow(raw, instance.domain);
    if (!row || seen.has(row.serverPublicId)) continue;
    seen.add(row.serverPublicId);
    rows.push(row);
  }

  if (mode === 'full') {
    const result = await replaceDirectoryCache(instance.id, rows, now);
    return { ok: true, rows: result.upserted, removed: result.removed };
  }

  const result = await refreshDirectoryCacheCounts(instance.id, rows);
  return { ok: true, rows: result.updated, removed: result.removed };
};

/**
 * Fire-and-forget pull for a pairing that just became active (our
 * accept, or the peer's), so its servers show up without waiting for
 * the daily tick. Carries its own rejection handler — an unguarded
 * rejection here is the CONNECTION_ENDED flake family.
 */
const pullDirectoryOnActivation = (instance: TPeerInstance): void => {
  if (!config.federation.enabled) return;

  syncDirectoryFromInstance(instance, 'full', Date.now())
    .then((outcome) => {
      if (outcome.ok) {
        logger.info(
          '[directory] pulled %d listing(s) from %s on activation',
          outcome.rows,
          instance.domain
        );
      } else {
        logger.warn(
          '[directory] activation pull from %s failed: %s',
          instance.domain,
          outcome.reason
        );
      }
    })
    .catch((err) => {
      logger.warn('[directory] activation pull from %s failed: %o', instance.domain, err);
    });
};

export {
  pullDirectoryOnActivation,
  syncDirectoryFromInstance,
  type TSyncMode,
  type TSyncOutcome
};
