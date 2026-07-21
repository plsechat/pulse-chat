import { ActivityLogType, DisconnectCode } from '@pulse/shared';
import { eq, or } from 'drizzle-orm';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import {
  channelNotificationSettings,
  channelReadStates,
  dmE2eeSenderKeys,
  dmReadStates,
  e2eeSenderKeys,
  friendRequests,
  friendships,
  invites,
  serverMembers,
  servers,
  userFederatedServers,
  userIdentityKeys,
  userOneTimePreKeys,
  userRoles,
  users,
  userSignedPreKeys
} from '../db/schema';
import { logger } from '../logger';
import { enqueueActivityLog } from '../queues/activity-log';
import { authBackend } from './auth';
import { relayUserInfoUpdate } from './federation-user-info-dispatch';
import { invariant } from './invariant';
import type { Context } from './trpc';

/**
 * The shared account-deletion core, used by self-service deletion
 * (users.deleteAccount, which adds name+password confirmation on top)
 * and admin-forced deletion (admin.deleteUser). The users row survives
 * as an ANONYMIZED TOMBSTONE (messages keep an author and conversations
 * keep their shape) while everything identifying is scrubbed and every
 * relationship row removed; the auth-side identity is deleted so login
 * is severed and the email freed.
 *
 * Refuses: already-deleted rows, federated shadows (managed by their
 * home instance), and users who still own servers (the community would
 * be orphaned — transfer or delete the server first).
 */
const executeAccountDeletion = async (
  targetUserId: number,
  getUserWs: Context['getUserWs']
): Promise<void> => {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      supabaseId: users.supabaseId,
      publicId: users.publicId,
      isFederated: users.isFederated,
      deletedAt: users.deletedAt
    })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  invariant(user && !user.deletedAt, {
    code: 'NOT_FOUND',
    message: 'User not found'
  });

  invariant(!user.isFederated, {
    code: 'BAD_REQUEST',
    message: 'Federated accounts are managed by their home instance.'
  });

  const owned = await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.ownerId, targetUserId));

  invariant(owned.length === 0, {
    code: 'FORBIDDEN',
    message: `This account still owns ${owned.length === 1 ? 'a server' : 'servers'} (${owned
      .map((s) => s.name)
      .join(
        ', '
      )}). Transfer ownership or delete ${owned.length === 1 ? 'it' : 'them'} first.`
  });

  const now = Date.now();
  // Unique-by-construction (publicId is unique) and unmistakably not
  // a real auth id, so the login path can never map back to this row.
  const tombstoneAuthId = `deleted:${user.publicId}`;
  const tombstoneName = `Deleted User ${user.publicId.slice(0, 6)}`;

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        name: tombstoneName,
        supabaseId: tombstoneAuthId,
        avatarId: null,
        bannerId: null,
        bio: null,
        pronouns: null,
        customStatus: null,
        customStatusEmoji: null,
        customStatusExpiresAt: null,
        nameplate: null,
        avatarDecoration: null,
        nameStyle: null,
        bannerColor: null,
        deletedAt: now,
        updatedAt: now
      })
      .where(eq(users.id, targetUserId));

    // Relationship rows go; dmChannelMembers deliberately stays so
    // partners keep their conversation (authored by the tombstone),
    // and messages/reactions/files stay untouched by design.
    await tx
      .delete(serverMembers)
      .where(eq(serverMembers.userId, targetUserId));
    await tx.delete(userRoles).where(eq(userRoles.userId, targetUserId));
    await tx
      .delete(friendships)
      .where(
        or(
          eq(friendships.userId, targetUserId),
          eq(friendships.friendId, targetUserId)
        )
      );
    await tx
      .delete(friendRequests)
      .where(
        or(
          eq(friendRequests.senderId, targetUserId),
          eq(friendRequests.receiverId, targetUserId)
        )
      );
    await tx.delete(invites).where(eq(invites.creatorId, targetUserId));
    await tx
      .delete(channelReadStates)
      .where(eq(channelReadStates.userId, targetUserId));
    await tx
      .delete(dmReadStates)
      .where(eq(dmReadStates.userId, targetUserId));
    await tx
      .delete(channelNotificationSettings)
      .where(eq(channelNotificationSettings.userId, targetUserId));
    await tx
      .delete(userFederatedServers)
      .where(eq(userFederatedServers.userId, targetUserId));

    // E2EE material: identity, prekeys, and every sender-key chain
    // from OR to this user — nobody should be able to fetch bundles
    // for (or address chains to) a deleted account.
    await tx
      .delete(userIdentityKeys)
      .where(eq(userIdentityKeys.userId, targetUserId));
    await tx
      .delete(userSignedPreKeys)
      .where(eq(userSignedPreKeys.userId, targetUserId));
    await tx
      .delete(userOneTimePreKeys)
      .where(eq(userOneTimePreKeys.userId, targetUserId));
    await tx
      .delete(e2eeSenderKeys)
      .where(
        or(
          eq(e2eeSenderKeys.fromUserId, targetUserId),
          eq(e2eeSenderKeys.toUserId, targetUserId)
        )
      );
    await tx
      .delete(dmE2eeSenderKeys)
      .where(
        or(
          eq(dmE2eeSenderKeys.fromUserId, targetUserId),
          eq(dmE2eeSenderKeys.toUserId, targetUserId)
        )
      );
  });

  // Sever auth AFTER the app-side commit: for local auth this is the
  // same DB and effectively can't fail independently; for Supabase a
  // failure leaves an auth orphan whose next login provisions a
  // FRESH app account (the scrubbed supabaseId no longer maps back),
  // so the tombstone can never be resurrected either way.
  const { error: authDeleteError } = await authBackend.deleteUserById(
    user.supabaseId
  );
  if (authDeleteError) {
    logger.error(
      '[deleteAccount] auth-side deletion failed for %s: %s',
      user.publicId,
      authDeleteError.message
    );
  }

  enqueueActivityLog({
    type: ActivityLogType.USER_DELETED_ACCOUNT,
    userId: targetUserId
  });

  // Everyone re-renders the tombstone; federated shadows get the
  // scrub pushed (and re-pull the avatarless profile).
  publishUser(targetUserId, 'update');
  relayUserInfoUpdate(targetUserId, {
    name: tombstoneName,
    bio: null,
    pronouns: null,
    bannerColor: null,
    nameplate: null,
    avatarDecoration: null,
    nameStyle: null,
    customStatus: null,
    customStatusEmoji: null,
    triggerProfileSync: true
  });

  // Drop every live connection — DEFERRED, because when the target is
  // the caller (self-service deletion) the mutation's own response
  // rides one of these sockets; closing synchronously would turn a
  // successful deletion into a client-side error.
  const userConnections = getUserWs(targetUserId);
  if (userConnections) {
    setTimeout(() => {
      for (const ws of userConnections) {
        try {
          ws.close(DisconnectCode.ACCOUNT_DELETED, 'Account deleted');
        } catch {
          // Socket may already be gone — nothing to do.
        }
      }
    }, 1500);
  }
};

export { executeAccountDeletion };
