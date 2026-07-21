import { ActivityLogType, DisconnectCode } from '@pulse/shared';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
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
} from '../../db/schema';
import { logger } from '../../logger';
import { enqueueActivityLog } from '../../queues/activity-log';
import { authBackend } from '../../utils/auth';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Self-service account deletion. The users row survives as an
 * ANONYMIZED TOMBSTONE (messages keep an author and conversations keep
 * their shape) while everything identifying is scrubbed and every
 * relationship row is removed; the auth-side identity is deleted so
 * login is severed and the email freed. Blocked while the user still
 * owns servers — ownership must be transferred or the servers deleted
 * first.
 */
const deleteAccountRoute = protectedProcedure
  .input(
    z.object({
      /** Must match the account's display name exactly. */
      confirmName: z.string().min(1).max(64),
      /** Required for password accounts; OIDC-only accounts omit it. */
      password: z.string().max(128).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
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
      .where(eq(users.id, ctx.userId))
      .limit(1);

    invariant(user && !user.deletedAt, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    invariant(!user.isFederated, {
      code: 'BAD_REQUEST',
      message: 'Federated accounts are managed by their home instance.'
    });

    invariant(input.confirmName === user.name, {
      code: 'BAD_REQUEST',
      message: 'The name you typed does not match your account name.'
    });

    // Owned servers block deletion — otherwise the community would be
    // orphaned. Transfer ownership or delete the server first.
    const owned = await db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.ownerId, ctx.userId));

    invariant(owned.length === 0, {
      code: 'FORBIDDEN',
      message: `You still own ${owned.length === 1 ? 'a server' : 'servers'} (${owned
        .map((s) => s.name)
        .join(
          ', '
        )}). Transfer ownership or delete ${owned.length === 1 ? 'it' : 'them'} first.`
    });

    // Password challenge, mirroring update-password: password accounts
    // must re-prove possession; OIDC-only accounts confirm by name
    // alone (they have no password here to check).
    const { data: authUserData } = await authBackend.getUserById(
      user.supabaseId
    );
    const providers = (authUserData.user?.identities ?? [])
      .map((i) => i.provider)
      .filter((p): p is string => typeof p === 'string');

    if (authUserData.user?.email && providers.includes('email')) {
      invariant(input.password, {
        code: 'BAD_REQUEST',
        message: 'Password is required to delete this account.'
      });

      const { error: signInError } = await authBackend.signInWithPassword({
        email: authUserData.user.email,
        password: input.password
      });

      invariant(!signInError, {
        code: 'UNAUTHORIZED',
        message: 'Password is incorrect.'
      });
    }

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
        .where(eq(users.id, ctx.userId));

      // Relationship rows go; dmChannelMembers deliberately stays so
      // partners keep their conversation (authored by the tombstone),
      // and messages/reactions/files stay untouched by design.
      await tx
        .delete(serverMembers)
        .where(eq(serverMembers.userId, ctx.userId));
      await tx.delete(userRoles).where(eq(userRoles.userId, ctx.userId));
      await tx
        .delete(friendships)
        .where(
          or(
            eq(friendships.userId, ctx.userId),
            eq(friendships.friendId, ctx.userId)
          )
        );
      await tx
        .delete(friendRequests)
        .where(
          or(
            eq(friendRequests.senderId, ctx.userId),
            eq(friendRequests.receiverId, ctx.userId)
          )
        );
      await tx.delete(invites).where(eq(invites.creatorId, ctx.userId));
      await tx
        .delete(channelReadStates)
        .where(eq(channelReadStates.userId, ctx.userId));
      await tx
        .delete(dmReadStates)
        .where(eq(dmReadStates.userId, ctx.userId));
      await tx
        .delete(channelNotificationSettings)
        .where(eq(channelNotificationSettings.userId, ctx.userId));
      await tx
        .delete(userFederatedServers)
        .where(eq(userFederatedServers.userId, ctx.userId));

      // E2EE material: identity, prekeys, and every sender-key chain
      // from OR to this user — nobody should be able to fetch bundles
      // for (or address chains to) a deleted account.
      await tx
        .delete(userIdentityKeys)
        .where(eq(userIdentityKeys.userId, ctx.userId));
      await tx
        .delete(userSignedPreKeys)
        .where(eq(userSignedPreKeys.userId, ctx.userId));
      await tx
        .delete(userOneTimePreKeys)
        .where(eq(userOneTimePreKeys.userId, ctx.userId));
      await tx
        .delete(e2eeSenderKeys)
        .where(
          or(
            eq(e2eeSenderKeys.fromUserId, ctx.userId),
            eq(e2eeSenderKeys.toUserId, ctx.userId)
          )
        );
      await tx
        .delete(dmE2eeSenderKeys)
        .where(
          or(
            eq(dmE2eeSenderKeys.fromUserId, ctx.userId),
            eq(dmE2eeSenderKeys.toUserId, ctx.userId)
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
      userId: ctx.userId
    });

    // Everyone re-renders the tombstone; federated shadows get the
    // scrub pushed (and re-pull the avatarless profile).
    publishUser(ctx.userId, 'update');
    relayUserInfoUpdate(ctx.userId, {
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

    // Drop every live connection — DEFERRED, because this mutation's
    // own response rides one of these sockets; closing synchronously
    // would turn a successful deletion into a client-side error. The
    // client signs out on success anyway; this is the backstop for
    // other tabs/devices.
    const userConnections = ctx.getUserWs(ctx.userId);
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
  });

export { deleteAccountRoute };
