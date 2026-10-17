import type { PluginContext, TPluginChannel } from '@pulse/plugin-sdk';
import { ActivityLogType, ChannelType, ServerEvents } from '@pulse/shared';
import type { TChannel } from '../../types';
import { randomUUIDv7 } from 'bun';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel, publishMessage } from '../../db/publishers';
import { notifyBridgeChannelCreated } from '../../routers/servers/bridge-hooks';
import {
  categories,
  channels,
  messages,
  servers,
  threadFollowers
} from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import {
  copyParentOverrides,
  getThreadViewerIds,
  publishPrivateThreadPermissions
} from '../../routers/threads/_shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';
import { getPluginActorUserId } from '../actor';
import { parseActionInput, PluginActionError } from '../errors';
import { eventBus } from '../event-bus';

/**
 * `ctx.actions.channels` — read the channel tree, add channels, open
 * threads. Creation follows channels.add / threads.create step for
 * step (position, file-access token, voice runtime, private-parent
 * override copy) and fans out through the same publishers, so a channel
 * a plugin makes shows up in every sidebar exactly like a user-made one.
 */

/** Same bounds as channels.add / threads.create / channels.update. */
const MAX_CHANNEL_NAME_LENGTH = 24;
const MAX_THREAD_NAME_LENGTH = 100;
const MAX_TOPIC_LENGTH = 128;
/** Ceiling on a channel listing; a server never legitimately has more. */
const MAX_LISTED_CHANNELS = 2000;

const id = z.number().int().positive();

const createSchema = z.object({
  serverId: id,
  name: z.string().trim().min(1).max(MAX_CHANNEL_NAME_LENGTH),
  type: z.enum(['TEXT', 'VOICE']),
  categoryId: id.optional(),
  topic: z.string().trim().max(MAX_TOPIC_LENGTH).optional()
});

const createThreadSchema = z.object({
  channelId: id,
  parentMessageId: id.optional(),
  name: z.string().trim().min(1).max(MAX_THREAD_NAME_LENGTH)
});

const toPluginChannel = (channel: TChannel): TPluginChannel => ({
  id: channel.id,
  publicId: channel.publicId,
  serverId: channel.serverId,
  name: channel.name,
  type: channel.type as TPluginChannel['type'],
  categoryId: channel.categoryId ?? null,
  parentChannelId: channel.parentChannelId ?? null,
  topic: channel.topic ?? null,
  private: channel.private,
  e2ee: channel.e2ee,
  archived: channel.archived ?? false,
  position: channel.position
});

const assertServerExists = async (serverId: number) => {
  const [server] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) {
    throw new PluginActionError('NOT_FOUND', 'Server not found');
  }
};

const createChannelActions = (
  pluginId: string
): PluginContext['actions']['channels'] => {
  const list: PluginContext['actions']['channels']['list'] = async (
    rawServerId
  ) => {
    const serverId = parseActionInput(id, rawServerId);
    await assertServerExists(serverId);

    const rows = await db
      .select()
      .from(channels)
      .where(eq(channels.serverId, serverId))
      .orderBy(asc(channels.categoryId), asc(channels.position), asc(channels.id))
      .limit(MAX_LISTED_CHANNELS);

    return rows.map(toPluginChannel);
  };

  const create: PluginContext['actions']['channels']['create'] = async (
    rawInput
  ) => {
    const input = parseActionInput(createSchema, rawInput);
    await assertServerExists(input.serverId);

    // The category must be one of THIS server's (channels.add checks the
    // same); without one the server's first category is used so a plugin
    // can create a channel without first reading the tree.
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.serverId, input.serverId),
          input.categoryId !== undefined
            ? eq(categories.id, input.categoryId)
            : undefined
        )
      )
      .orderBy(asc(categories.position), asc(categories.id))
      .limit(1);

    if (!category) {
      throw new PluginActionError(
        'NOT_FOUND',
        input.categoryId !== undefined
          ? 'Category not found'
          : 'This server has no category to put the channel in'
      );
    }

    const actorUserId = await getPluginActorUserId();

    const channel = await db.transaction(async (tx) => {
      const [last] = await tx
        .select({ position: channels.position })
        .from(channels)
        .where(eq(channels.categoryId, category.id))
        .orderBy(desc(channels.position))
        .limit(1);

      const now = Date.now();

      const [row] = await tx
        .insert(channels)
        .values({
          position: last ? last.position + 1 : 0,
          name: input.name,
          type: input.type === 'VOICE' ? ChannelType.VOICE : ChannelType.TEXT,
          topic: input.topic,
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          categoryId: category.id,
          serverId: input.serverId,
          publicId: randomUUIDv7(),
          createdAt: now
        })
        .returning();

      return row!;
    });

    // A mediasoup router only for channels that carry voice — boot and
    // channels.add create them the same way.
    if (channel.type === ChannelType.VOICE) {
      await new VoiceRuntime(channel.id).init();
    }

    await publishChannel(channel.id, 'create');
    enqueueActivityLog({
      type: ActivityLogType.CREATED_CHANNEL,
      userId: actorUserId,
      details: {
        channelId: channel.id,
        channelName: channel.name,
        type: channel.type as ChannelType
      }
    });

    // Same hook as channels.add: a whole-server bridge pairs the new
    // channel (detached; only the link lookup is awaited).
    await notifyBridgeChannelCreated(channel.serverId);

    return toPluginChannel(channel);
  };

  const createThread: PluginContext['actions']['channels']['createThread'] =
    async (rawInput) => {
      const input = parseActionInput(createThreadSchema, rawInput);

      const [parent] = await db
        .select()
        .from(channels)
        .where(eq(channels.id, input.channelId))
        .limit(1);

      if (!parent) {
        throw new PluginActionError('NOT_FOUND', 'Channel not found');
      }

      // A thread may only hang off a TEXT or FORUM channel (threads/_shared).
      if (parent.type !== ChannelType.TEXT && parent.type !== ChannelType.FORUM) {
        throw new PluginActionError(
          'BAD_REQUEST',
          'Threads can only be created in text or forum channels'
        );
      }

      let parentMessage: { id: number; channelId: number; threadId: number | null } | undefined;

      if (input.parentMessageId !== undefined) {
        const [row] = await db
          .select({
            id: messages.id,
            channelId: messages.channelId,
            threadId: messages.threadId
          })
          .from(messages)
          .where(eq(messages.id, input.parentMessageId))
          .limit(1);

        if (!row || row.channelId !== parent.id) {
          throw new PluginActionError(
            'NOT_FOUND',
            'Parent message not found in this channel'
          );
        }

        if (row.threadId) {
          throw new PluginActionError(
            'CONFLICT',
            'Message already has a thread'
          );
        }

        parentMessage = row;
      }

      const actorUserId = await getPluginActorUserId();
      const now = Date.now();

      const thread = await db.transaction(async (tx) => {
        // Encryption and visibility are inherited: a plaintext/public
        // thread under an encrypted/private parent would leak what the
        // parent protects (threads/create-thread.ts).
        const [row] = await tx
          .insert(channels)
          .values({
            type: ChannelType.THREAD,
            name: input.name,
            position: 0,
            fileAccessToken: randomUUIDv7(),
            fileAccessTokenUpdatedAt: now,
            serverId: parent.serverId,
            parentChannelId: parent.id,
            private: parent.private,
            e2ee: parent.e2ee,
            archived: false,
            autoArchiveDuration: 1440,
            publicId: randomUUIDv7(),
            createdAt: now
          })
          .returning();

        if (parent.private) {
          await copyParentOverrides(tx, parent.id, row!.id, now);
        }

        if (parentMessage) {
          await tx
            .update(messages)
            .set({ threadId: row!.id })
            .where(eq(messages.id, parentMessage.id));
        }

        // Forum posts auto-follow their creator so the plugin's actor
        // keeps seeing replies (create-forum-post.ts does the same).
        if (parent.type === ChannelType.FORUM) {
          await tx
            .insert(threadFollowers)
            .values({ threadId: row!.id, userId: actorUserId, createdAt: now })
            .onConflictDoNothing();
        }

        return row!;
      });

      await publishChannel(thread.id, 'create');

      if (parentMessage) {
        await publishMessage(parentMessage.id, parent.id, 'update');
      }

      const viewerIds = await getThreadViewerIds(thread.id);
      await publishPrivateThreadPermissions(parent.private, viewerIds);
      pubsub.publishFor(viewerIds, ServerEvents.THREAD_CREATE, {
        id: thread.id,
        name: thread.name,
        messageCount: 0,
        lastMessageAt: null,
        archived: false,
        parentChannelId: parent.id,
        creatorId: actorUserId
      });

      eventBus.emit('thread:created', {
        threadId: thread.id,
        parentChannelId: parent.id,
        serverId: parent.serverId,
        name: thread.name,
        creatorId: actorUserId,
        parentMessageId: parentMessage?.id,
        pluginId
      });

      return toPluginChannel(thread);
    };

  return { list, create, createThread };
};

export { createChannelActions };
