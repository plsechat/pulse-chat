import { ChannelType, DEFAULT_ROLE_PERMISSIONS, Permission } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { z } from 'zod';
import { db } from '../../db';
import {
  getServersByUserId
} from '../../db/queries/servers';
import {
  categories,
  channels,
  rolePermissions,
  roles,
  serverMembers,
  servers,
  userRoles
} from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const createServerRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(2).max(24),
      description: z.string().max(128).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const now = Date.now();

    const server = await db.transaction(async (tx) => {
      // Create server
      const [newServer] = await tx
        .insert(servers)
        .values({
          name: input.name,
          description: input.description ?? null,
          password: null,
          publicId: randomUUIDv7(),
          secretToken: randomUUIDv7(),
          ownerId: ctx.userId,
          allowNewUsers: true,
          storageUploadEnabled: true,
          storageQuota: 1073741824, // 1GB
          storageUploadMaxFileSize: 10485760, // 10MB
          storageSpaceQuotaByUser: 104857600, // 100MB
          storageOverflowAction: 'REJECT',
          enablePlugins: false,
          createdAt: now
        })
        .returning();

      const serverId = newServer!.id;

      // Add creator as member
      await tx.insert(serverMembers).values({
        serverId,
        userId: ctx.userId,
        joinedAt: now
      });

      // Create owner role for this server
      const [ownerRole] = await tx
        .insert(roles)
        .values({
          name: 'Owner',
          color: '#e74c3c',
          isPersistent: true,
          isDefault: false,
          serverId,
          createdAt: now
        })
        .returning();

      // Create default member role
      const [memberRole] = await tx
        .insert(roles)
        .values({
          name: 'Member',
          color: '#ffffff',
          isPersistent: true,
          isDefault: true,
          serverId,
          createdAt: now
        })
        .returning();

      // Grant all permissions to owner role
      const allPermissions = Object.values(Permission);
      if (allPermissions.length > 0) {
        await tx.insert(rolePermissions).values(
          allPermissions.map((perm) => ({
            roleId: ownerRole!.id,
            permission: perm,
            createdAt: now,
            updatedAt: now
          }))
        );
      }

      // Grant default permissions to member role
      if (DEFAULT_ROLE_PERMISSIONS.length > 0) {
        await tx.insert(rolePermissions).values(
          DEFAULT_ROLE_PERMISSIONS.map((perm) => ({
            roleId: memberRole!.id,
            permission: perm,
            createdAt: now,
            updatedAt: now
          }))
        );
      }

      // Assign owner role to creator
      await tx.insert(userRoles).values({
        userId: ctx.userId,
        roleId: ownerRole!.id,
        createdAt: now
      });

      // Assign default role to creator
      await tx.insert(userRoles).values({
        userId: ctx.userId,
        roleId: memberRole!.id,
        createdAt: now
      });

      // Create General category
      const [category] = await tx
        .insert(categories)
        .values({
          name: 'General',
          position: 0,
          serverId,
          createdAt: now
        })
        .returning();

      // Create general text channel
      await tx.insert(channels).values({
        type: ChannelType.TEXT,
        name: 'general',
        position: 0,
        fileAccessToken: randomUUIDv7(),
        fileAccessTokenUpdatedAt: now,
        categoryId: category!.id,
        serverId,
        createdAt: now
      });

      return newServer!;
    });

    // Return updated server list
    const joinedServers = await getServersByUserId(ctx.userId);
    const summary = joinedServers.find((s) => s.id === server.id);

    return summary!;
  });

export { createServerRoute };
