import { ChannelType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, forumTags } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';

// Rendered as CSS by the client — accept a hex colour only.
const HEX_COLOR_RE = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

const getForumTagsRoute = serverProcedure()
  .input(z.object({ channelId: z.number().int().positive() }))
  .query(async ({ input, ctx }) => {
    // Confirm the channel is in the active server before exposing its tags.
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (!channel) return [];

    return db
      .select()
      .from(forumTags)
      .where(eq(forumTags.channelId, input.channelId));
  });

const createForumTagRoute = serverProcedure()
  .input(
    z.object({
      channelId: z.number().int().positive(),
      name: z.string().min(1).max(50),
      color: z.string().regex(HEX_COLOR_RE, 'Invalid hex color').optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select({ serverId: channels.serverId, type: channels.type })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (!channel || channel.type !== ChannelType.FORUM) {
      return ctx.throwValidationError('channelId', 'Forum channel not found');
    }

    await ctx.needsPermission(Permission.MANAGE_CHANNELS, channel.serverId);

    const [tag] = await db
      .insert(forumTags)
      .values({
        channelId: input.channelId,
        name: input.name,
        color: input.color ?? '#808080',
        createdAt: Date.now()
      })
      .returning();

    return tag;
  });

const updateForumTagRoute = serverProcedure()
  .input(
    z.object({
      tagId: z.number().int().positive(),
      name: z.string().min(1).max(50).optional(),
      color: z.string().regex(HEX_COLOR_RE, 'Invalid hex color').optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [tag] = await db
      .select()
      .from(forumTags)
      .where(eq(forumTags.id, input.tagId))
      .limit(1);

    if (!tag) {
      return ctx.throwValidationError('tagId', 'Tag not found');
    }

    const [channel] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(
        and(
          eq(channels.id, tag.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (!channel) {
      return ctx.throwValidationError('tagId', 'Forum channel not found');
    }

    await ctx.needsPermission(Permission.MANAGE_CHANNELS, channel.serverId);

    const updates: Partial<typeof forumTags.$inferInsert> = {};
    if (input.name) updates.name = input.name;
    if (input.color) updates.color = input.color;

    const [updated] = await db
      .update(forumTags)
      .set(updates)
      .where(eq(forumTags.id, input.tagId))
      .returning();

    return updated;
  });

const deleteForumTagRoute = serverProcedure()
  .input(z.object({ tagId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const [tag] = await db
      .select()
      .from(forumTags)
      .where(eq(forumTags.id, input.tagId))
      .limit(1);

    if (!tag) {
      return ctx.throwValidationError('tagId', 'Tag not found');
    }

    const [channel] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(
        and(
          eq(channels.id, tag.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (!channel) {
      return ctx.throwValidationError('tagId', 'Forum channel not found');
    }

    await ctx.needsPermission(Permission.MANAGE_CHANNELS, channel.serverId);

    await db.delete(forumTags).where(eq(forumTags.id, input.tagId));
  });

export {
  createForumTagRoute,
  deleteForumTagRoute,
  getForumTagsRoute,
  updateForumTagRoute
};
