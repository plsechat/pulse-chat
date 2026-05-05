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

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { logger } from '../logger';
import { relayToInstance } from './federation';
import { enumerateRotationPeers } from './federation-dm-group-dispatch';

type UserInfoChanges = {
  name?: string;
  bio?: string | null;
  bannerColor?: string | null;
  status?: string; // UserStatus value
  // When true, peer instances re-fetch the full profile via the
  // existing pull endpoint (skipping the debounce). Used by
  // changeAvatar / changeBanner since the new file content has to
  // be downloaded — sending it inline through this dispatch isn't
  // worth the wire overhead, and the pull path already handles
  // the file download.
  triggerProfileSync?: boolean;
};

/**
 * Push user-info changes for `localUserId` to every peer instance
 * that's likely to hold a shadow user for them.
 */
async function relayUserInfoUpdate(
  localUserId: number,
  changes: UserInfoChanges
): Promise<void> {
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
    relayToInstance(domain, '/federation/user-info-update', {
      subjectPublicId: user.publicId,
      ...changes
    }).catch((err) =>
      logger.error(
        '[relayUserInfoUpdate] relay to %s failed: %o',
        domain,
        err
      )
    );
  }
}

export { relayUserInfoUpdate };
