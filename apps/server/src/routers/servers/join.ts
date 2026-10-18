import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { consumeInvite, releaseInvite } from '../../db/queries/invites';
import { getDefaultRoleForServer } from '../../db/queries/roles';
import {
  addServerMember,
  getServerById,
  getServersByUserId,
  isServerMember
} from '../../db/queries/servers';
import { invites, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { announceMemberJoin } from '../../utils/membership-events';
import { protectedProcedure } from '../../utils/trpc';

// Membership join by invite code (servers.joinByInvite). Opening the
// joined server on this socket is a separate others.openSession call.
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

    // One fan-out to every member: the joiner's rail entry and the
    // existing members' roster add (they see the new user without
    // waiting for their first session on the server).
    await announceMemberJoin({
      pubsub: ctx.pubsub,
      server,
      userId: ctx.userId,
      username: ctx.user.name,
      summary
    });

    return summary;
  });

export { joinServerByInviteRoute };
