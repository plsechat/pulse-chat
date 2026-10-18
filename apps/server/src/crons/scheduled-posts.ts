import { ChannelPermission, Permission } from '@pulse/shared';
import { and, asc, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { db } from '../db';
import { publishMessage } from '../db/publishers';
import { getAffectedUserIdsForChannel } from '../db/queries/channels';
import {
  cancelScheduledPost,
  publishScheduledPostUpdate,
  type TScheduledPostRow
} from '../db/queries/scheduled-posts';
import {
  channels,
  files,
  messageFiles,
  messages,
  scheduledPostFiles,
  scheduledPosts
} from '../db/schema';
import { parseMentionedUserIds } from '../helpers/parse-mentions';
import { logger } from '../logger';
import { eventBus } from '../plugins/event-bus';
import { enqueueProcessMetadata } from '../queues/message-metadata';
import { relayAnnouncement } from '../utils/announcement-follow';
import {
  assertNotTimedOut,
  checkAutomod,
  executeAutomodActions
} from '../utils/automod';
import {
  userHasChannelPermission,
  userHasServerPermission
} from '../utils/member-permissions';

/** Due rows sent per tick; a backlog beyond this goes out next minute. */
const TICK_BATCH = 100;
/** Sent and cancelled rows are kept this long for the list, then pruned. */
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;

/**
 * Why a due row was dropped instead of sent — logged, and the row is
 * cancelled so the list shows the author it will not go out.
 */
type TDropReason =
  | 'channel gone'
  | 'author may no longer post here'
  | 'author is timed out'
  | 'blocked by auto-moderation';

/**
 * Everything the direct send route checks about the AUTHOR, evaluated
 * now — at send time — rather than when the row was written: a member
 * who left, lost SEND_MESSAGES, lost the announcer role, or is timed
 * out does not get a message posted on their behalf.
 */
const authorMayPost = async (
  post: TScheduledPostRow,
  channel: typeof channels.$inferSelect
): Promise<TDropReason | null> => {
  const serverOk = await userHasServerPermission(
    post.userId,
    channel.serverId,
    Permission.SEND_MESSAGES
  );
  const channelOk =
    serverOk &&
    (await userHasChannelPermission(
      post.userId,
      channel.serverId,
      channel.id,
      ChannelPermission.SEND_MESSAGES
    ));
  const announcerOk =
    channelOk &&
    (!channel.announcement ||
      (await userHasServerPermission(
        post.userId,
        channel.serverId,
        Permission.MANAGE_ANNOUNCEMENTS
      )));

  if (!announcerOk) return 'author may no longer post here';

  try {
    await assertNotTimedOut(
      {
        userId: post.userId,
        hasPermission: async (permission, serverId) => {
          const list = Array.isArray(permission) ? permission : [permission];
          for (const p of list) {
            if (!(await userHasServerPermission(post.userId, serverId ?? channel.serverId, p))) {
              return false;
            }
          }
          return true;
        }
      },
      channel.serverId
    );
  } catch {
    return 'author is timed out';
  }

  return null;
};

const drop = async (post: TScheduledPostRow, reason: TDropReason, now: number) => {
  logger.info('[scheduled-posts] row %d not sent: %s', post.id, reason);
  await cancelScheduledPost(post.id, now);
  await publishScheduledPostUpdate(post.channelId);
};

/**
 * Post one due row as its author through the steps a direct send
 * takes: automod (with its actions), mention parsing, the message row,
 * the attachments (moved from scheduled_post_files to message_files),
 * the fan-out, link previews, the plugin event and the announcement
 * copies. Returns true when a message was posted.
 */
const sendScheduledPost = async (post: TScheduledPostRow, now: number): Promise<boolean> => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, post.channelId))
    .limit(1);

  if (!channel) {
    await drop(post, 'channel gone', now);
    return false;
  }

  const refusal = await authorMayPost(post, channel);
  if (refusal) {
    await drop(post, refusal, now);
    return false;
  }

  const content = post.content.length > 0 ? post.content : null;

  if (content) {
    const automodResult = await checkAutomod(content, channel.id, post.userId, channel.serverId);

    if (automodResult.blocked && automodResult.actions) {
      await executeAutomodActions(automodResult.actions, {
        channelId: channel.id,
        userId: post.userId,
        content,
        serverId: channel.serverId,
        ruleName: automodResult.matchedRuleName ?? 'Unknown',
        authorId: automodResult.matchedRuleCreatedBy
      });
      await drop(post, 'blocked by auto-moderation', now);
      return false;
    }
  }

  let mentionedUserIds: number[] | null = null;
  let mentionsAll = false;
  if (content) {
    const memberIds = await getAffectedUserIdsForChannel(channel.id);
    const parsed = await parseMentionedUserIds(content, memberIds);
    mentionedUserIds = parsed.userIds.length > 0 ? parsed.userIds : null;
    mentionsAll = parsed.mentionsAll;
  }

  const [message] = await db
    .insert(messages)
    .values({
      channelId: channel.id,
      userId: post.userId,
      content,
      e2ee: false,
      editable: true,
      mentionedUserIds,
      mentionsAll,
      createdAt: now
    })
    .returning({ id: messages.id });
  const messageId = message!.id;

  // Claim the row with the message it became: a cancel that landed in
  // between (or a second sender) wins this conditional UPDATE, and the
  // message just inserted is taken back — no scheduled row ever
  // becomes two messages or a message the author withdrew.
  const [claimed] = await db
    .update(scheduledPosts)
    .set({ sentMessageId: messageId })
    .where(
      and(
        eq(scheduledPosts.id, post.id),
        isNull(scheduledPosts.sentMessageId),
        isNull(scheduledPosts.cancelledAt)
      )
    )
    .returning({ id: scheduledPosts.id });

  if (!claimed) {
    await db.delete(messages).where(eq(messages.id, messageId));
    return false;
  }

  const fileRows = await db
    .select({ file: files })
    .from(scheduledPostFiles)
    .innerJoin(files, eq(scheduledPostFiles.fileId, files.id))
    .where(eq(scheduledPostFiles.scheduledPostId, post.id));

  const attachments: { name: string; url: string; size: number }[] = [];
  for (const { file } of fileRows) {
    await db.insert(messageFiles).values({ messageId, fileId: file.id, createdAt: now });
    attachments.push({ name: file.name, url: `/public/${file.name}`, size: file.size });
  }
  if (fileRows.length > 0) {
    await db.delete(scheduledPostFiles).where(eq(scheduledPostFiles.scheduledPostId, post.id));
  }

  await publishMessage(messageId, channel.id, 'create');

  if (content) {
    enqueueProcessMetadata(content, messageId);
    eventBus.emit('message:created', {
      messageId,
      channelId: channel.id,
      userId: post.userId,
      content,
      replyToId: null,
      attachments
    });
  }

  void relayAnnouncement(messageId, 'create');
  await publishScheduledPostUpdate(channel.id);

  return true;
};

/** Finished rows older than the keep window go; nothing references them. */
const pruneFinished = async (now: number) => {
  await db
    .delete(scheduledPosts)
    .where(
      or(
        and(isNotNull(scheduledPosts.cancelledAt), lt(scheduledPosts.cancelledAt, now - KEEP_FINISHED_MS)),
        and(isNotNull(scheduledPosts.sentMessageId), lt(scheduledPosts.sendAt, now - KEEP_FINISHED_MS))
      )
    );
};

/**
 * One sender pass at `now` (injectable for tests): every due row in
 * send order, each on its own so one failing row does not hold the
 * others back. Returns the number of messages posted.
 */
const scheduledPostsTick = async (now: number = Date.now()): Promise<number> => {
  const due = await db
    .select()
    .from(scheduledPosts)
    .where(
      and(
        lte(scheduledPosts.sendAt, now),
        isNull(scheduledPosts.sentMessageId),
        isNull(scheduledPosts.cancelledAt)
      )
    )
    .orderBy(asc(scheduledPosts.sendAt), asc(scheduledPosts.id))
    .limit(TICK_BATCH);

  let sent = 0;

  for (const post of due) {
    try {
      if (await sendScheduledPost(post, now)) sent += 1;
    } catch (err) {
      logger.error('[scheduled-posts] sending row %d failed: %o', post.id, err);
    }
  }

  try {
    await pruneFinished(now);
  } catch (err) {
    logger.error('[scheduled-posts] prune failed: %o', err);
  }

  return sent;
};

export { scheduledPostsTick };
