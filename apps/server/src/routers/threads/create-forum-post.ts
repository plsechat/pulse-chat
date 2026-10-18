import {
  ChannelPermission,
  ChannelType,
  MAX_FILES_PER_POST,
  MAX_MESSAGE_CONTENT_LENGTH,
  Permission,
  ServerEvents
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel, publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import {
  channels,
  forumPostTags,
  messageFiles,
  messages,
  threadFollowers
} from '../../db/schema';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { eventBus } from '../../plugins/event-bus';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { channelProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';
import {
  copyParentOverrides,
  getThreadViewerIds,
  MAX_TAGS_PER_POST,
  MAX_TEMP_FILE_ID_LENGTH,
  publishPrivateThreadPermissions,
  resolveForumTagIds
} from './_shared';

// Channel-level SEND_MESSAGES (implies VIEW) on the forum itself — the
// server-level flag alone says nothing about a private forum.
const createForumPostRoute = channelProcedure(
  ChannelPermission.SEND_MESSAGES,
  { serverPermission: Permission.SEND_MESSAGES }
)
  .input(
    z.object({
      title: z.string().min(1).max(200),
      // Same plaintext budget as an ordinary message in the thread.
      content: z.string().min(1).max(MAX_MESSAGE_CONTENT_LENGTH),
      tagIds: z
        .array(z.number().int().positive())
        .max(MAX_TAGS_PER_POST)
        .optional(),
      files: z
        .array(z.string().min(1).max(MAX_TEMP_FILE_ID_LENGTH))
        .max(MAX_FILES_PER_POST)
        .optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const forumChannel = ctx.channel;

    if (forumChannel.type !== ChannelType.FORUM) {
      return ctx.throwValidationError('channelId', 'Forum channel not found');
    }

    // The opening post is plaintext by construction; it cannot live in
    // an encrypted thread, and an encrypted forum has no way to carry it.
    invariant(!forumChannel.e2ee, {
      code: 'BAD_REQUEST',
      message: 'Encrypted forums do not support posts'
    });

    const tagIds = await resolveForumTagIds(forumChannel.id, input.tagIds);

    const now = Date.now();

    const result = await db.transaction(async (tx) => {
      // Create thread channel for the forum post. Visibility is
      // inherited: a public post under a private forum would leak it.
      const [thread] = await tx
        .insert(channels)
        .values({
          type: ChannelType.THREAD,
          name: input.title,
          position: 0,
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          serverId: forumChannel.serverId,
          parentChannelId: forumChannel.id,
          private: forumChannel.private,
          e2ee: forumChannel.e2ee,
          archived: false,
          autoArchiveDuration: 1440,
          publicId: randomUUIDv7(),
          createdAt: now
        })
        .returning();

      if (forumChannel.private) {
        await copyParentOverrides(tx, forumChannel.id, thread!.id, now);
      }

      // Create the initial message in the thread
      const [firstMessage] = await tx
        .insert(messages)
        .values({
          content: input.content,
          userId: ctx.userId,
          channelId: thread!.id,
          createdAt: now
        })
        .returning();

      // Attach tags if provided
      if (tagIds.length > 0) {
        await tx.insert(forumPostTags).values(
          tagIds.map((tagId) => ({
            threadId: thread!.id,
            tagId
          }))
        );
      }

      // Auto-follow the creator
      await tx
        .insert(threadFollowers)
        .values({
          threadId: thread!.id,
          userId: ctx.userId,
          createdAt: now
        })
        .onConflictDoNothing();

      return { thread: thread!, message: firstMessage! };
    });

    // Parse @mentions in the initial post content
    const channelMemberIds = await getAffectedUserIdsForChannel(
      result.thread.id
    );
    const { userIds: mentionedUserIds, mentionsAll } =
      await parseMentionedUserIds(input.content, channelMemberIds);

    if (mentionedUserIds.length > 0 || mentionsAll) {
      await db
        .update(messages)
        .set({
          mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : null,
          mentionsAll
        })
        .where(eq(messages.id, result.message.id));
    }

    // Attach files to the initial message
    if (input.files && input.files.length > 0) {
      for (const tempFileId of input.files) {
        const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

        await db.insert(messageFiles).values({
          messageId: result.message.id,
          fileId: newFile.id,
          createdAt: Date.now()
        });
      }
    }

    // Publish events
    publishChannel(result.thread.id, 'create');
    publishMessage(result.message.id, result.thread.id, 'create');

    const viewerIds = await getThreadViewerIds(result.thread.id);
    await publishPrivateThreadPermissions(forumChannel.private, viewerIds);
    pubsub.publishFor(viewerIds, ServerEvents.THREAD_CREATE, {
      id: result.thread.id,
      name: result.thread.name,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
      parentChannelId: forumChannel.id,
      creatorId: ctx.userId
    });

    eventBus.emit('thread:created', {
      threadId: result.thread.id,
      parentChannelId: forumChannel.id,
      serverId: forumChannel.serverId,
      name: result.thread.name,
      creatorId: ctx.userId
    });

    return { threadId: result.thread.id };
  });

export { createForumPostRoute };
