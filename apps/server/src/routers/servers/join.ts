import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
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
      inviteCode: z.string().min(1)
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Find invite
    const [invite] = await db
      .select()
      .from(invites)
      .where(eq(invites.code, input.inviteCode))
      .limit(1);

    invariant(invite, {
      code: 'NOT_FOUND',
      message: 'Invalid invite code'
    });

    // Check expiry
    if (invite.expiresAt && invite.expiresAt < Date.now()) {
      ctx.throwValidationError('inviteCode', 'This invite has expired');
    }

    // Check max uses
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

    // Check if already a member
    const alreadyMember = await isServerMember(server.id, ctx.userId);

    if (alreadyMember) {
      // Already a member, just return server summary
      const servers = await getServersByUserId(ctx.userId);
      return servers.find((s) => s.id === server.id)!;
    }

    // Check if server allows new users
    invariant(server.allowNewUsers, {
      code: 'FORBIDDEN',
      message: 'This server is not accepting new members'
    });

    // Add member
    await addServerMember(server.id, ctx.userId);

    // Assign default role
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

    // Increment invite uses
    await db
      .update(invites)
      .set({ uses: invite.uses + 1 })
      .where(eq(invites.id, invite.id));

    // Publish event
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
        publicUser
      );
    }

    return summary;
  });

export { joinServerByInviteRoute };
