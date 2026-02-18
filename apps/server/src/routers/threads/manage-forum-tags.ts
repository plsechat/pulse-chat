import { ChannelType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, forumTags } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const getForumTagsRoute = protectedProcedure
  .input(z.object({ channelId: z.number() }))
  .query(async ({ input }) => {
    return db
      .select()
      .from(forumTags)
      .where(eq(forumTags.channelId, input.channelId));
  });

const createForumTagRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      name: z.string().min(1).max(50),
      color: z.string().max(20).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select({ serverId: channels.serverId, type: channels.type })
      .from(channels)
      .where(eq(channels.id, input.channelId))
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

const updateForumTagRoute = protectedProcedure
  .input(
    z.object({
      tagId: z.number(),
      name: z.string().min(1).max(50).optional(),
      color: z.string().max(20).optional()
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
      .where(eq(channels.id, tag.channelId))
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

const deleteForumTagRoute = protectedProcedure
  .input(z.object({ tagId: z.number() }))
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
      .where(eq(channels.id, tag.channelId))
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
