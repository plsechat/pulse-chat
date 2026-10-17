import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '..';
import type { TScheduledPostView } from '../../types';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import { removeFile } from '../mutations/files';
import { channels, files, scheduledPostFiles, scheduledPosts } from '../schema';
import { getAffectedUserIdsForChannel } from './channels';

type TScheduledPostRow = typeof scheduledPosts.$inferSelect;

const attachFiles = async (
  rows: TScheduledPostRow[]
): Promise<TScheduledPostView[]> => {
  if (rows.length === 0) return [];

  const fileRows = await db
    .select({
      scheduledPostId: scheduledPostFiles.scheduledPostId,
      id: files.id,
      name: files.name,
      originalName: files.originalName,
      size: files.size
    })
    .from(scheduledPostFiles)
    .innerJoin(files, eq(scheduledPostFiles.fileId, files.id))
    .where(
      inArray(
        scheduledPostFiles.scheduledPostId,
        rows.map((r) => r.id)
      )
    );

  const byPost = new Map<number, TScheduledPostView['files']>();
  for (const f of fileRows) {
    const list = byPost.get(f.scheduledPostId) ?? [];
    list.push({ id: f.id, name: f.name, originalName: f.originalName, size: f.size });
    byPost.set(f.scheduledPostId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    userId: row.userId,
    content: row.content,
    sendAt: row.sendAt,
    createdAt: row.createdAt,
    files: byPost.get(row.id) ?? []
  }));
};

/** Pending rows of a channel — everyone's, or one author's. */
const listPendingScheduledPosts = async (
  channelId: number,
  authorId?: number
): Promise<TScheduledPostView[]> => {
  const rows = await db
    .select()
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.channelId, channelId),
        isNull(scheduledPosts.sentMessageId),
        isNull(scheduledPosts.cancelledAt),
        authorId === undefined ? undefined : eq(scheduledPosts.userId, authorId)
      )
    )
    .orderBy(asc(scheduledPosts.sendAt), asc(scheduledPosts.id));

  return attachFiles(rows);
};

/** A pending row with its channel, scoped to one server (cross-server → undefined). */
const getScheduledPostInServer = async (
  scheduledPostId: number,
  serverId: number
): Promise<
  { post: TScheduledPostRow; channel: typeof channels.$inferSelect } | undefined
> => {
  const [row] = await db
    .select({ post: scheduledPosts, channel: channels })
    .from(scheduledPosts)
    .innerJoin(channels, eq(scheduledPosts.channelId, channels.id))
    .where(and(eq(scheduledPosts.id, scheduledPostId), eq(channels.serverId, serverId)))
    .limit(1);

  return row;
};

/**
 * Mark the row cancelled and drop its uploads: the files only existed
 * for this post, and the orphan scan would otherwise keep them alive
 * for as long as the cancelled row stays. The conditional UPDATE makes
 * a cancel that races the sender a no-op on whichever side loses.
 */
const cancelScheduledPost = async (
  scheduledPostId: number,
  now: number
): Promise<boolean> => {
  const [cancelled] = await db
    .update(scheduledPosts)
    .set({ cancelledAt: now })
    .where(
      and(
        eq(scheduledPosts.id, scheduledPostId),
        isNull(scheduledPosts.sentMessageId),
        isNull(scheduledPosts.cancelledAt)
      )
    )
    .returning({ id: scheduledPosts.id });

  if (!cancelled) return false;

  const fileRows = await db
    .select({ fileId: scheduledPostFiles.fileId })
    .from(scheduledPostFiles)
    .where(eq(scheduledPostFiles.scheduledPostId, scheduledPostId));

  for (const { fileId } of fileRows) {
    await removeFile(fileId);
  }

  return true;
};

/** Tell the channel's viewers the Scheduled list changed; fire and forget. */
const publishScheduledPostUpdate = async (channelId: number): Promise<void> => {
  try {
    const audience = await getAffectedUserIdsForChannel(channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    pubsub.publishFor(audience, ServerEvents.SCHEDULED_POST_UPDATE, { channelId });
  } catch (err) {
    logger.error('[scheduled-posts] publish failed for channel %d: %o', channelId, err);
  }
};

export {
  cancelScheduledPost,
  getScheduledPostInServer,
  listPendingScheduledPosts,
  publishScheduledPostUpdate,
  type TScheduledPostRow
};
