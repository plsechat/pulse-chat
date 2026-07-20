import { ChannelType } from '@pulse/shared';
import { and, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getRolesForServer } from '../../db/queries/roles';
import { getServerPublicSettings } from '../../db/queries/server';
import { getServerById, isServerMember } from '../../db/queries/servers';
import { categories, channels, invites, serverMembers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

// Read-only preview of a server the caller has NOT joined, reached from
// the Discover list (serverId, requires discoverable) or an invite code
// (validated but NOT consumed). Sets ctx.previewServerId, which grants
// exactly VIEW_CHANNEL on the server's public channels (see
// hasChannelPermission in utils/wss.ts). Snapshot-style: no realtime
// events, no read states, no channel permissions.
const previewServerRoute = protectedProcedure
  .input(
    z
      .object({
        serverId: z.number().int().positive().optional(),
        inviteCode: z.string().min(1).max(64).optional()
      })
      .refine(
        (v) => (v.serverId === undefined) !== (v.inviteCode === undefined),
        { message: 'Provide exactly one of serverId or inviteCode' }
      )
  )
  .mutation(async ({ input, ctx }) => {
    let server;

    if (input.inviteCode !== undefined) {
      const [invite] = await db
        .select()
        .from(invites)
        .where(eq(invites.code, input.inviteCode))
        .limit(1);

      invariant(invite, {
        code: 'NOT_FOUND',
        message: 'Invalid invite code'
      });

      invariant(!invite.expiresAt || invite.expiresAt >= Date.now(), {
        code: 'FORBIDDEN',
        message: 'This invite has expired'
      });

      // Validate remaining uses WITHOUT consuming one — only an actual
      // join (servers.join) increments.
      invariant(!invite.maxUses || invite.uses < invite.maxUses, {
        code: 'FORBIDDEN',
        message: 'This invite has reached its maximum uses'
      });

      server = await getServerById(invite.serverId);
    } else {
      server = await getServerById(input.serverId!);

      invariant(!server || server.discoverable, {
        code: 'FORBIDDEN',
        message: 'This server is not discoverable'
      });
    }

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    // Members must use the normal join flow — setting previewServerId
    // would downgrade their own permissions on this server to
    // VIEW_CHANNEL-only for the rest of the connection.
    const alreadyMember = await isServerMember(server.id, ctx.userId);
    invariant(!alreadyMember, {
      code: 'BAD_REQUEST',
      message: 'You are already a member of this server'
    });

    ctx.previewServerId = server.id;

    const [allCategories, channelRows, roles, publicSettings, memberCountRow] =
      await Promise.all([
        db
          .select()
          .from(categories)
          .where(eq(categories.serverId, server.id)),
        // Only public text-capable channels — private channels (and their
        // file access tokens) must not reach a previewer.
        db
          .select({
            id: channels.id,
            type: channels.type,
            name: channels.name,
            topic: channels.topic,
            private: channels.private,
            position: channels.position,
            categoryId: channels.categoryId,
            serverId: channels.serverId,
            slowMode: channels.slowMode,
            parentChannelId: channels.parentChannelId,
            archived: channels.archived,
            autoArchiveDuration: channels.autoArchiveDuration,
            forumDefaultSort: channels.forumDefaultSort,
            e2ee: channels.e2ee,
            publicId: channels.publicId,
            createdAt: channels.createdAt,
            updatedAt: channels.updatedAt
          })
          .from(channels)
          .where(
            and(
              eq(channels.serverId, server.id),
              eq(channels.private, false),
              ne(channels.type, ChannelType.VOICE)
            )
          ),
        getRolesForServer(server.id),
        getServerPublicSettings(server.id),
        db
          .select({ count: count() })
          .from(serverMembers)
          .where(eq(serverMembers.serverId, server.id))
      ]);

    return {
      serverId: server.publicId,
      serverDbId: server.id,
      serverName: server.name,
      description: server.description ?? '',
      logo: server.logo,
      memberCount: memberCountRow[0]?.count ?? 0,
      hasPassword: !!server.password,
      // Echoed back so the client can join with the same invite later.
      inviteCode: input.inviteCode ?? null,
      categories: allCategories,
      channels: channelRows,
      // Name colors only — the permission matrix is member-facing.
      roles: roles.map((role) => ({ ...role, permissions: [] })),
      publicSettings
    };
  });

export { previewServerRoute };
