import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { consumeInvite, releaseInvite } from '../../db/queries/invites';
import { getDefaultRoleForServer } from '../../db/queries/roles';
import {
  addServerMember,
  getServerById,
  getServerMemberIds,
  getServersByUserId,
  isServerMember
} from '../../db/queries/servers';
import { getPublicUserById } from '../../db/queries/users';
import { invites, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const joinServerByInviteRoute = protectedProcedure
  .input(
    z.object({
      inviteCode: z.string().min(1).max(64)
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [invite] = await db
      .select()
      .from(invites)
      .where(eq(invites.code, input.inviteCode))
      .limit(1);

    invariant(invite, {
      code: 'NOT_FOUND',
      message: 'Invalid invite code'
    });

    if (invite.expiresAt && invite.expiresAt < Date.now()) {
      ctx.throwValidationError('inviteCode', 'This invite has expired');
    }

    if (invite.maxUses && invite.uses >= invite.maxUses) {
      ctx.throwValidationError(
        'inviteCode',
        'This invite has reached its maximum uses'
      );
    }

    const server = await getServerById(invite.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    // Already a member: nothing to consume, just return the summary.
    if (await isServerMember(server.id, ctx.userId)) {
      const servers = await getServersByUserId(ctx.userId);
      return servers.find((s) => s.id === server.id)!;
    }

    // Every refusal happens BEFORE a use is consumed — joining a closed
    // server used to burn a use of a max-uses invite and then fail.
    invariant(server.allowNewUsers, {
      code: 'FORBIDDEN',
      message: 'This server is not accepting new members'
    });

    // One conditional UPDATE: the expiry / max-uses check and the
    // increment are atomic, so two joins racing for the last use cannot
    // both pass.
    const consumed = await consumeInvite(invite.code);
    if (!consumed) {
      ctx.throwValidationError(
        'inviteCode',
        'This invite has reached its maximum uses'
      );
    }

    try {
      await addServerMember(server.id, ctx.userId, invite.id);

      const defaultRole = await getDefaultRoleForServer(server.id);
      if (defaultRole) {
        await db
          .insert(userRoles)
          .values({
            userId: ctx.userId,
            roleId: defaultRole.id,
            createdAt: Date.now()
          })
          .onConflictDoNothing();
      }
    } catch (err) {
      // The join did not go through — give the use back.
      await releaseInvite(invite.code);
      throw err;
    }

    const servers = await getServersByUserId(ctx.userId);
    const summary = servers.find((s) => s.id === server.id)!;

    ctx.pubsub.publishFor(ctx.userId, ServerEvents.SERVER_MEMBER_JOIN, {
      serverId: server.id,
      userId: ctx.userId,
      server: summary
    });

    // Notify existing members so they see the new user in the member list
    const memberIds = await getServerMemberIds(server.id);
    const publicUser = await getPublicUserById(ctx.userId);
    if (publicUser) {
      ctx.pubsub.publishFor(
        memberIds.filter((id) => id !== ctx.userId),
        ServerEvents.USER_JOIN,
        {
          serverId: server.id,
          serverPublicId: server.publicId,
          user: publicUser
        }
      );
    }

    return summary;
  });

export { joinServerByInviteRoute };
