/**
 * Phase E / E3 — server-side dispatcher that pushes user-info
 * changes (status, profile fields) to peer instances that hold a
 * shadow user for the changed user.
 *
 * Peer enumeration scope: every active federation instance whose
 * users share a DM channel with the changed user. This is the same
 * scope D3 (identity rotation) uses; it covers exactly the peers
 * that are likely to have a shadow user for our local user. Peers
 * that don't have a shadow ignore the push with `ignored:
 * unknown_subject` — wasted but harmless.
 *
 * Fire-and-forget per peer; one failure doesn't block siblings.
 */

import type { TNameStyle } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { logger } from '../logger';
import { enumerateRotationPeers } from './federation-dm-group-dispatch';
import { enqueueRelay } from './federation-outbox';

type UserInfoChanges = {
  name?: string;
  bio?: string | null;
  bannerColor?: string | null;
  pronouns?: string | null;
  // Only 'preset:<slug>' values (or null) — 'custom:<id>' references the
  // sender's local nameplates table and is sent as null instead.
  nameplate?: string | null;
  // 'preset:<slug>' or null — decoration presets are client-bundled
  // assets, so they cross instances as-is.
  avatarDecoration?: string | null;
  // Fonts/effects are client-bundled too; the receiver re-validates the
  // shape against nameStyleSchema.
  nameStyle?: TNameStyle | null;
  customStatus?: string | null;
  customStatusEmoji?: string | null;
  status?: string; // UserStatus value
  // When true, peer instances re-fetch the full profile via the
  // existing pull endpoint (skipping the debounce). Used by
  // changeAvatar / changeBanner since the new file content has to
  // be downloaded — sending it inline through this dispatch isn't
  // worth the wire overhead, and the pull path already handles
  // the file download.
  triggerProfileSync?: boolean;
};

type RelayUserInfoOptions = {
  /**
   * Presence pushes are transient: attempted once, never queued. A
   * status that failed to reach a peer is superseded by the next one,
   * so retrying it later would only deliver stale state.
   */
  transient?: boolean;
};

/**
 * Push user-info changes for `localUserId` to every peer instance
 * that's likely to hold a shadow user for them. Profile changes go
 * through the outbox (a peer that is restarting still gets the rename
 * / new avatar); presence (`transient`) does not.
 */
async function relayUserInfoUpdate(
  localUserId: number,
  changes: UserInfoChanges,
  opts?: RelayUserInfoOptions
): Promise<void> {
  // The whole body is guarded, not just the per-relay promises: every
  // call site is fire-and-forget (`void fn()` / no catch), so a DB error
  // in the lookups BEFORE the relay would otherwise surface as an
  // unhandled rejection.
  try {
    if (Object.keys(changes).length === 0) return;

    const [user] = await db
      .select({ publicId: users.publicId, isFederated: users.isFederated })
      .from(users)
      .where(eq(users.id, localUserId))
      .limit(1);

    // Only push for local users — federated shadow users on this
    // instance get their updates from their home instance, not us.
    if (!user || user.isFederated || !user.publicId) return;

    const peerDomains = await enumerateRotationPeers(localUserId);
    if (peerDomains.length === 0) return;

    for (const domain of peerDomains) {
      enqueueRelay(
        domain,
        '/federation/user-info-update',
        {
          subjectPublicId: user.publicId,
          ...changes
        },
        { transient: opts?.transient }
      ).catch((err) =>
        logger.error(
          '[relayUserInfoUpdate] relay to %s failed: %o',
          domain,
          err
        )
      );
    }
  } catch (err) {
    logger.error('[relayUserInfoUpdate] dispatch failed: %o', err);
  }
}

// ─── Presence ────────────────────────────────────────────────────────────
//
// Status is runtime state: a peer that holds a shadow for one of our
// users only learns online/idle/dnd from an explicit push, and nothing
// pushed on connect or disconnect. On the peer our user therefore sat
// OFFLINE until they picked a status by hand, and stayed in that
// status forever after logging out. The two hooks below close that:
// the join route calls `relayPresenceConnected` when a user's FIRST
// live socket completes its join, the WS close handler calls
// `schedulePresenceOffline` when their LAST socket closes.
//
// The offline push is debounced: a page refresh closes the old socket
// a moment before the new one joins, and peers should not see a
// flicker to offline for that. The timer re-checks the live socket
// count when it fires and does nothing if the user came back.

const PRESENCE_OFFLINE_DEBOUNCE_MS = 5_000;
let presenceOfflineDebounceMs = PRESENCE_OFFLINE_DEBOUNCE_MS;
const pendingOffline = new Map<number, ReturnType<typeof setTimeout>>();

const cancelPendingOffline = (userId: number): void => {
  const timer = pendingOffline.get(userId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingOffline.delete(userId);
};

/**
 * First live socket of a local user finished joining: push their
 * current status to peers that hold a shadow for them. Cancels a
 * pending offline push (reconnect inside the debounce window) and
 * pushes anyway — the status override is cleared on disconnect, so
 * what the peer last saw may no longer be right.
 */
function relayPresenceConnected(userId: number, status: string): void {
  cancelPendingOffline(userId);
  void relayUserInfoUpdate(userId, { status }, { transient: true });
}

/**
 * Last live socket of a local user closed: push `offline` after the
 * debounce unless `stillConnected()` reports a new socket by then.
 */
function schedulePresenceOffline(
  userId: number,
  stillConnected: () => boolean
): void {
  cancelPendingOffline(userId);
  const timer = setTimeout(() => {
    pendingOffline.delete(userId);
    if (stillConnected()) return;
    void relayUserInfoUpdate(userId, { status: 'offline' }, { transient: true });
  }, presenceOfflineDebounceMs);
  pendingOffline.set(userId, timer);
}

/** Test-only: shorten the offline debounce; `undefined` restores it. */
export function _setPresenceOfflineDebounceForTests(ms: number | undefined): void {
  presenceOfflineDebounceMs = ms ?? PRESENCE_OFFLINE_DEBOUNCE_MS;
}

export { relayPresenceConnected, relayUserInfoUpdate, schedulePresenceOffline };
