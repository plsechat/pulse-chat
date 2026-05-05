/**
 * Phase E / E3 — federation route for event-driven user-info push.
 *
 * Existing `/federation/user-info` is a request/response pull: a
 * peer asks "give me X's profile" when it needs to refresh a shadow
 * row. That works for cold-start and lazy refresh, but it leaves
 * federated user *status* (online/idle/away/dnd) perpetually stale
 * because status is runtime, not persisted, and there's no
 * mechanism to push the update.
 *
 * This handler is the push side. When any user-info field changes
 * on a sender's home instance, the home instance pushes the update
 * here. The body shape is additive — receivers ignore unknown
 * fields, partial updates are valid:
 *
 *   {
 *     fromDomain: string                 // signed
 *     subjectPublicId: string            // sender's local user (their publicId on their home)
 *     // Persisted fields:
 *     name?: string
 *     bio?: string | null
 *     bannerColor?: string | null
 *     // Runtime field:
 *     status?: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
 *     // (avatar / banner reserved for follow-up — they need file-download)
 *   }
 *
 * Receiver semantics:
 *   - Resolve shadow user by (fromInstance, subjectPublicId)
 *   - Apply persisted fields to the users row
 *   - Apply runtime status via setRuntimeUserStatus
 *   - Pubsub USER_UPDATE locally so subscribers reflect the change
 *   - Idempotent: applying the same state twice is a no-op
 */

import { UserStatus } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { syncShadowUserProfile } from '../db/mutations/federation';
import { users } from '../db/schema';
import { publishUser } from '../db/publishers';
import { logger } from '../logger';
import { signedJsonResponse } from '../utils/federation';
import { setRuntimeUserStatus } from '../utils/wss';
import {
  authorizeFederationRequest,
  jsonResponse
} from './federation-helpers';

// Mirror of the UserStatus enum surface validated against incoming
// strings. `'online'` is a valid arrival and clears any runtime
// override; `'invisible'` flips the runtime to invisible (which
// `getStatusById` collapses to OFFLINE for other users).
const VALID_STATUSES: ReadonlySet<string> = new Set([
  UserStatus.ONLINE,
  UserStatus.IDLE,
  UserStatus.DND,
  UserStatus.INVISIBLE,
  UserStatus.OFFLINE
]);

const federationUserInfoUpdateHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const subjectPublicId = signedBody.subjectPublicId as string | undefined;
  const nameChange = signedBody.name as string | undefined;
  const bioChange = signedBody.bio as string | null | undefined;
  const bannerColorChange = signedBody.bannerColor as string | null | undefined;
  const statusChange = signedBody.status as string | undefined;
  const triggerProfileSync = signedBody.triggerProfileSync === true;

  if (!subjectPublicId || typeof subjectPublicId !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing subjectPublicId' });
  }

  // At least one change must be present — empty pushes are bugs in
  // the dispatcher caller.
  const hasAnyChange =
    nameChange !== undefined ||
    bioChange !== undefined ||
    bannerColorChange !== undefined ||
    statusChange !== undefined ||
    triggerProfileSync;
  if (!hasAnyChange) {
    return jsonResponse(res, 400, { error: 'No changes specified' });
  }

  if (statusChange !== undefined && !VALID_STATUSES.has(statusChange)) {
    return jsonResponse(res, 400, { error: 'Invalid status value' });
  }

  // Resolve the shadow user. If we don't have one for this peer
  // (we've never seen them via federation), 200 ignored — the
  // dispatcher's idempotent retry doesn't loop on transient
  // asymmetry, and we avoid leaking peer-existence by status code.
  const [shadow] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instance.id),
        eq(users.federatedPublicId, subjectPublicId)
      )
    )
    .limit(1);

  if (!shadow) {
    logger.warn(
      '[user-info-update] no shadow for subjectPublicId, ignoring'
    );
    return signedJsonResponse(res, 200, { ignored: 'unknown_subject' }, fromDomain);
  }

  // Apply persisted fields. Build an update set conditionally so
  // we don't overwrite NULLs onto fields the sender didn't change.
  const persistedSet: Record<string, unknown> = {};
  if (nameChange !== undefined) persistedSet.name = nameChange;
  if (bioChange !== undefined) persistedSet.bio = bioChange;
  if (bannerColorChange !== undefined) persistedSet.bannerColor = bannerColorChange;

  if (Object.keys(persistedSet).length > 0) {
    persistedSet.updatedAt = Date.now();
    await db.update(users).set(persistedSet).where(eq(users.id, shadow.id));
  }

  // Apply runtime status if present.
  if (statusChange !== undefined) {
    setRuntimeUserStatus(shadow.id, statusChange as UserStatus);
  }

  // Broadcast USER_UPDATE locally to every co-member of the shadow
  // user. publishUser handles co-member enumeration and emits the
  // standard payload shape clients already subscribe to. The
  // statusOverride hint forces the runtime status into the payload
  // even though it isn't persisted in the users table.
  await publishUser(shadow.id, 'update', {
    statusOverride:
      statusChange !== undefined ? (statusChange as UserStatus) : undefined
  });

  // Avatar / banner can't be sent inline through this dispatch
  // (the file content has to be downloaded). Instead we trigger
  // the existing forced-pull path, which fetches the full profile
  // from the home and downloads any new file via the standard
  // federated-file pipeline. Fire-and-forget — the receiver doesn't
  // wait for the file download to complete; the second pubsub
  // (USER_UPDATE) inside syncShadowUserProfile will re-broadcast
  // once the new files are in place.
  if (triggerProfileSync) {
    void syncShadowUserProfile(shadow.id, fromDomain, subjectPublicId, {
      force: true
    }).catch((err) =>
      logger.error('[user-info-update] forced profile sync failed: %o', err)
    );
  }

  return signedJsonResponse(res, 200, { applied: true }, fromDomain);
};

export { federationUserInfoUpdateHandler };
