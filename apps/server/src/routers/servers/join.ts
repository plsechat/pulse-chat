import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  addServerMember,
  getServerById,
  getServersByUserId,
  isServerMember
} from '../../db/queries/servers';
import { getDefaultRoleForServer } from '../../db/queries/roles';
import { invites } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { userRoles } from '../../db/schema';

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

    return summary;
  });

export { joinServerByInviteRoute };
