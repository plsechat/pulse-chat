import type {
  PluginContext,
  TPluginEditMessageInput,
  TPluginMessageRef,
  TPluginPostMessageInput
} from '@pulse/plugin-sdk';
import type { TMessageMetadata } from '@pulse/shared';
import {
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH,
  normalizeReaction,
  PERSONA_MEDIA_TYPE,
  PLUGIN_DATA_MEDIA_TYPE,
  pluginDataEntry
} from '@pulse/shared';
import type { TChannel, TMessage } from '../../types';
import { randomUUIDv7 } from 'bun';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { tombstoneMessages } from '../../db/mutations/messages';
import { publishMessage } from '../../db/publishers';
import {
  relayAnnouncement,
  relayAnnouncementDeletion
} from '../../utils/announcement-follow';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getEmojiFileIdByEmojiName } from '../../db/queries/emojis';
import { getReaction } from '../../db/queries/messages';
import {
  getPluginMessageLinkByExternalId,
  getPluginMessageLinkByMessageId,
  insertPluginMessageLink,
  RESERVED_EXTERNAL_ID_PREFIX
} from '../../db/queries/plugin-message-links';
import {
  channels,
  files,
  messageFiles,
  messageReactions,
  messages
} from '../../db/schema';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { enqueueProcessMetadata } from '../../queues/message-metadata';
import { checkAutomod, executeAutomodActions } from '../../utils/automod';
import { getPluginActorUserId } from '../actor';
import {
  isUniqueViolation,
  parseActionInput,
  PluginActionError
} from '../errors';
import { eventBus } from '../event-bus';

/**
 * `ctx.actions.messages` — the plugin's write access to channel chat.
 *
 * Every post goes down the same road as an inbound webhook message: the
 * row is stored under the plugin's own actor account (see actor.ts), the
 * persona the reader sees travels in `metadata` exactly like the webhook
 * alias and avatar, auto-moderation runs with that account as the
 * accountable user, and `publishMessage` fans the result out. What a plugin may touch
 * afterwards is decided by plugin_message_links: its own posts, or any
 * message once the manifest declares `moderate-messages`.
 */

/** Same ceilings the user and webhook routes enforce. */
const MAX_AUTHOR_NAME_LENGTH = 80;
const MAX_AVATAR_URL_LENGTH = 2048;
const MAX_EXTERNAL_ID_LENGTH = 256;
const MAX_FILES_PER_MESSAGE = 10;
/** A unicode emoji or a `:custom_name:` token — never free text. */
const MAX_EMOJI_LENGTH = 64;
/**
 * Card state is one jsonb entry fanned out with every message event,
 * so it is kept small: a handful of keys, a few KiB. A plugin that
 * needs more keeps it on its own side and puts a reference here.
 */
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_BYTES = 8 * 1024;

const id = z.number().int().positive();

/** `/public/<file>` as returned by files.upload, or an absolute http(s) URL. */
const avatarUrlSchema = z
  .string()
  .max(MAX_AVATAR_URL_LENGTH)
  .refine(
    (value) => value.startsWith('/public/') || /^https?:\/\//i.test(value),
    'author.avatarUrl must be a /public/<file> path or an http(s) URL'
  );

/**
 * Plain JSON only: `JSON.stringify` drops functions and undefined
 * silently, so the size check runs on what would actually be stored.
 */
const metadataSchema = z
  .record(z.string().min(1).max(MAX_METADATA_KEY_LENGTH), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_METADATA_KEYS, {
    message: `metadata may hold at most ${MAX_METADATA_KEYS} keys`
  })
  .refine(
    (value) => {
      const serialised = JSON.stringify(value);
      return serialised !== undefined && Buffer.byteLength(serialised) <= MAX_METADATA_BYTES;
    },
    { message: `metadata may not exceed ${MAX_METADATA_BYTES} bytes as JSON` }
  );

const postSchema = z.object({
  channelId: id,
  content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH, 'Message is too long'),
  author: z
    .object({
      name: z.string().trim().min(1).max(MAX_AUTHOR_NAME_LENGTH),
      avatarUrl: avatarUrlSchema.optional()
    })
    .optional(),
  replyToId: id.optional(),
  attachments: z
    .array(z.object({ fileId: id }))
    .max(MAX_FILES_PER_MESSAGE)
    .optional(),
  externalId: z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_ID_LENGTH)
    .refine(
      (value) => !value.startsWith(RESERVED_EXTERNAL_ID_PREFIX),
      `externalId may not start with "${RESERVED_EXTERNAL_ID_PREFIX}"`
    )
    .optional(),
  metadata: metadataSchema.optional()
});

const refSchema = z.union([
  z.object({ messageId: id, externalId: z.undefined().optional() }),
  z.object({
    externalId: z.string().min(1).max(MAX_EXTERNAL_ID_LENGTH),
    messageId: z.undefined().optional()
  })
]);

const editSchema = z
  .object({
    content: z
      .string()
      .min(1, 'content is required')
      .max(MAX_MESSAGE_CONTENT_LENGTH, 'Message is too long')
      .optional(),
    metadata: metadataSchema.optional()
  })
  .refine((value) => value.content !== undefined || value.metadata !== undefined, {
    message: 'content or metadata is required'
  });

const reactSchema = z.object({
  emoji: z.string().min(1).max(MAX_EMOJI_LENGTH),
  remove: z.boolean().optional()
});

type TOwnedMessage = {
  message: TMessage;
  channel: TChannel;
  /** True when a plugin_message_links row names the plugin as the poster. */
  owned: boolean;
};

type TMessageActionDeps = {
  pluginId: string;
  /** The manifest name; the plugin's actor account is named after it. */
  pluginName: string;
  hasCapability: (capability: 'moderate-messages') => boolean;
  log: (...message: unknown[]) => void;
};

const loadChannel = async (channelId: number): Promise<TChannel | undefined> => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return channel;
};

/**
 * Only channels that carry readable chat: voice channels have no chat,
 * a forum's own row holds posts (threads), not messages, and an
 * encrypted channel cannot take plaintext from the server side (the
 * webhook and user routes refuse the same).
 */
const assertPostable = (channel: TChannel) => {
  if (channel.type === ChannelType.VOICE) {
    throw new PluginActionError(
      'BAD_REQUEST',
      'Voice channels do not support text messages'
    );
  }

  if (channel.type === ChannelType.FORUM) {
    throw new PluginActionError(
      'BAD_REQUEST',
      'Forum channels hold posts; create one with channels.createThread and post into it'
    );
  }

  if (channel.e2ee) {
    throw new PluginActionError(
      'BAD_REQUEST',
      'Plugins cannot post into end-to-end encrypted channels'
    );
  }
};

/**
 * Runs the server's auto-moderation for `content` with the plugin's
 * actor as the accountable user — the webhook path does the same for
 * its creator — and executes the rule's actions when it blocks.
 */
const assertNotBlockedByAutomod = async (
  content: string,
  channel: TChannel,
  actorUserId: number
) => {
  const result = await checkAutomod(
    content,
    channel.id,
    actorUserId,
    channel.serverId
  );

  if (!result.blocked) return;

  if (result.actions) {
    await executeAutomodActions(result.actions, {
      channelId: channel.id,
      userId: actorUserId,
      content,
      serverId: channel.serverId,
      ruleName: result.matchedRuleName ?? 'Unknown',
      authorId: result.matchedRuleCreatedBy
    });
  }

  throw new PluginActionError('FORBIDDEN', 'Message blocked by auto-moderation');
};

const parseMentions = async (content: string, channelId: number) => {
  const memberIds = await getAffectedUserIdsForChannel(channelId);
  const parsed = await parseMentionedUserIds(content, memberIds);

  return {
    mentionedUserIds: parsed.userIds.length > 0 ? parsed.userIds : null,
    mentionsAll: parsed.mentionsAll
  };
};

const createMessageActions = ({
  pluginId,
  pluginName,
  hasCapability,
  log
}: TMessageActionDeps): PluginContext['actions']['messages'] => {
  /** The plugin's own account, a member of the channel's server from its first action there. */
  const actorIn = (serverId: number) =>
    getPluginActorUserId({ pluginId, name: pluginName, serverId });

  /**
   * Resolve a ref to the message and decide whether this plugin may act
   * on it. By externalId the link row is the lookup itself, so a foreign
   * id reads as NOT_FOUND. By messageId the row is loaded first and then
   * the claim checked, so a plugin without `moderate-messages` is told
   * FORBIDDEN rather than NOT_FOUND — the message is not a secret, the
   * permission is the thing missing.
   */
  const resolve = async (rawRef: unknown): Promise<TOwnedMessage> => {
    const ref = parseActionInput(refSchema, rawRef) as TPluginMessageRef;
    let messageId: number;
    let owned = false;

    if (ref.externalId !== undefined) {
      const link = await getPluginMessageLinkByExternalId(
        pluginId,
        ref.externalId
      );

      if (!link) {
        throw new PluginActionError('NOT_FOUND', 'Message not found');
      }

      messageId = link.messageId;
      owned = true;
    } else {
      messageId = ref.messageId;
      owned = !!(await getPluginMessageLinkByMessageId(pluginId, messageId));
    }

    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!message) {
      throw new PluginActionError('NOT_FOUND', 'Message not found');
    }

    // A tombstone (deletion keeps the row) takes no further action: its
    // link row was released with the content, so by externalId it is
    // already NOT_FOUND above; by messageId say what happened.
    if (message.deletedAt) {
      throw new PluginActionError('NOT_FOUND', 'Message was deleted');
    }

    if (!owned && !hasCapability('moderate-messages')) {
      throw new PluginActionError(
        'FORBIDDEN',
        'This plugin may only act on messages it posted; declare the "moderate-messages" capability to act on others'
      );
    }

    const channel = await loadChannel(message.channelId);

    if (!channel) {
      throw new PluginActionError('NOT_FOUND', 'Message not found');
    }

    return { message, channel, owned };
  };

  const post: PluginContext['actions']['messages']['post'] = async (
    rawInput
  ) => {
    const input = parseActionInput(
      postSchema,
      rawInput
    ) as TPluginPostMessageInput;

    // Idempotent re-delivery: the first post with this externalId wins
    // and every later one gets its id back.
    if (input.externalId !== undefined) {
      const existing = await getPluginMessageLinkByExternalId(
        pluginId,
        input.externalId
      );

      if (existing) return { messageId: existing.messageId };
    }

    const channel = await loadChannel(input.channelId);

    if (!channel) {
      throw new PluginActionError('NOT_FOUND', 'Channel not found');
    }

    assertPostable(channel);

    const content = input.content.trim();
    const attachments = input.attachments ?? [];

    if (content.length === 0 && attachments.length === 0) {
      throw new PluginActionError(
        'BAD_REQUEST',
        'A message needs content or at least one attachment'
      );
    }

    const actorUserId = await actorIn(channel.serverId);

    // A reply may only point at a message in the SAME channel — the
    // reply preview ships the target's text to everyone who sees the
    // new message (send-message.ts enforces the same).
    if (input.replyToId !== undefined) {
      const [target] = await db
        .select({
          channelId: messages.channelId,
          deletedAt: messages.deletedAt
        })
        .from(messages)
        .where(eq(messages.id, input.replyToId))
        .limit(1);

      if (!target || target.channelId !== channel.id) {
        throw new PluginActionError(
          'BAD_REQUEST',
          'Reply target not found in this channel'
        );
      }

      if (target.deletedAt) {
        throw new PluginActionError(
          'BAD_REQUEST',
          'Reply target was deleted'
        );
      }
    }

    // Attachments must be files this plugin's actor stored (files.upload)
    // and plaintext: an encrypted blob under a plaintext message has no
    // key for anyone to open it with.
    if (attachments.length > 0) {
      const fileIds = [...new Set(attachments.map((a) => a.fileId))];
      const rows = await db
        .select({
          id: files.id,
          userId: files.userId,
          encrypted: files.encrypted
        })
        .from(files)
        .where(inArray(files.id, fileIds));

      if (rows.length !== fileIds.length) {
        throw new PluginActionError('NOT_FOUND', 'Attachment not found');
      }

      for (const file of rows) {
        if (file.userId !== actorUserId) {
          throw new PluginActionError(
            'FORBIDDEN',
            `File ${file.id} was not uploaded through this plugin's actor`
          );
        }

        if (file.encrypted) {
          throw new PluginActionError(
            'BAD_REQUEST',
            `File ${file.id} is encrypted and cannot be attached to a plaintext message`
          );
        }
      }
    }

    if (content.length > 0) {
      await assertNotBlockedByAutomod(content, channel, actorUserId);
    }

    const mentions =
      content.length > 0
        ? await parseMentions(content, channel.id)
        : { mentionedUserIds: null, mentionsAll: false };

    // Persona: snapshotted onto the message like the webhook alias, so a
    // later rename on the plugin's side never rewrites history. The
    // `webhook` media type is what the client already renders as a
    // display-name + avatar override; `siteName` tells the two apart.
    const persona: TMessageMetadata[] = input.author
      ? [
          {
            url: '',
            title: input.author.name,
            siteName: 'plugin',
            description: pluginId,
            mediaType: PERSONA_MEDIA_TYPE,
            ...(input.author.avatarUrl ? { images: [input.author.avatarUrl] } : {})
          }
        ]
      : [];
    // Card state rides in the same column as its own entry; the
    // preview pipeline keeps both when it adds link previews.
    const stored: TMessageMetadata[] = input.metadata
      ? [...persona, pluginDataEntry(pluginId, input.metadata)]
      : persona;
    const metadata: TMessageMetadata[] | null = stored.length > 0 ? stored : null;

    const externalId =
      input.externalId ?? `${RESERVED_EXTERNAL_ID_PREFIX}auto:${randomUUIDv7()}`;
    const now = Date.now();

    let messageId: number;

    try {
      messageId = await db.transaction(async (tx) => {
        const [message] = await tx
          .insert(messages)
          .values({
            channelId: channel.id,
            userId: actorUserId,
            content: content.length > 0 ? content : null,
            e2ee: false,
            editable: true,
            replyToId: input.replyToId,
            mentionedUserIds: mentions.mentionedUserIds,
            mentionsAll: mentions.mentionsAll,
            metadata,
            createdAt: now
          })
          .returning({ id: messages.id });

        if (attachments.length > 0) {
          await tx.insert(messageFiles).values(
            [...new Set(attachments.map((a) => a.fileId))].map((fileId) => ({
              messageId: message!.id,
              fileId,
              createdAt: now
            }))
          );
        }

        await insertPluginMessageLink(tx, {
          pluginId,
          externalId,
          messageId: message!.id,
          channelId: channel.id
        });

        return message!.id;
      });
    } catch (error) {
      // Two deliveries of one externalId raced: the other transaction's
      // row is the message; ours rolled back with it.
      if (isUniqueViolation(error) && input.externalId !== undefined) {
        const winner = await getPluginMessageLinkByExternalId(
          pluginId,
          input.externalId
        );

        if (winner) return { messageId: winner.messageId };

        throw new PluginActionError(
          'CONFLICT',
          'A concurrent post with the same externalId was rolled back; retry'
        );
      }

      throw error;
    }

    await publishMessage(messageId, channel.id, 'create');
    // A plugin post into an announcement channel reaches its followers
    // like a member's would; the relay is a no-op elsewhere.
    await relayAnnouncement(messageId, 'create');

    if (content.length > 0) {
      enqueueProcessMetadata(content, messageId);

      eventBus.emit('message:created', {
        messageId,
        channelId: channel.id,
        userId: actorUserId,
        content,
        pluginId
      });
    }

    log(`Posted message ${messageId} to channel ${channel.id}`);

    return { messageId };
  };

  const edit: PluginContext['actions']['messages']['edit'] = async (
    rawInput
  ) => {
    const { message, channel } = await resolve(rawInput);
    const { content, metadata } = parseActionInput(
      editSchema,
      rawInput
    ) as TPluginEditMessageInput;

    if (message.e2ee) {
      throw new PluginActionError(
        'BAD_REQUEST',
        'Encrypted messages cannot be edited by a plugin'
      );
    }

    if (message.editable === false) {
      throw new PluginActionError('FORBIDDEN', 'This message is not editable');
    }

    // The plugin's card entry is replaced whole; the persona and the
    // link previews next to it stay as they are.
    const nextMetadata =
      metadata !== undefined
        ? [
            ...(message.metadata ?? []).filter(
              (entry) => !(entry.mediaType === PLUGIN_DATA_MEDIA_TYPE && entry.pluginId === pluginId)
            ),
            pluginDataEntry(pluginId, metadata)
          ]
        : undefined;

    // A metadata-only edit changes the card, not the text: no automod
    // (nothing new is said), no "(edited)" mark, no message:updated —
    // a bridge mirroring the text has nothing to mirror.
    if (content === undefined) {
      await db
        .update(messages)
        .set({ metadata: nextMetadata, updatedAt: Date.now() })
        .where(eq(messages.id, message.id));

      await publishMessage(message.id, channel.id, 'update');
      return;
    }

    const actorUserId = await actorIn(channel.serverId);

    // An edit is a second chance to publish blocked content (edit-message.ts).
    await assertNotBlockedByAutomod(content, channel, actorUserId);

    const mentions = await parseMentions(content, channel.id);

    await db
      .update(messages)
      .set({
        content,
        edited: true,
        updatedAt: Date.now(),
        mentionedUserIds: mentions.mentionedUserIds,
        mentionsAll: mentions.mentionsAll,
        ...(nextMetadata !== undefined ? { metadata: nextMetadata } : {})
      })
      .where(eq(messages.id, message.id));

    await publishMessage(message.id, channel.id, 'update');
    await relayAnnouncement(message.id, 'update');
    enqueueProcessMetadata(content, message.id);

    eventBus.emit('message:updated', {
      messageId: message.id,
      channelId: channel.id,
      userId: message.userId,
      content,
      pluginId
    });
  };

  const remove: PluginContext['actions']['messages']['delete'] = async (
    rawInput
  ) => {
    const { message, channel } = await resolve(rawInput);

    // Same as delete-message.ts: the row stays as a tombstone attributed
    // to the plugin's actor; attachments, reactions and the link row go
    // with the content (db/mutations/messages.ts).
    const deletedAt = Date.now();
    const deletedBy = await actorIn(channel.serverId);
    await tombstoneMessages([message.id], deletedBy, deletedAt);
    const tombstone = { deletedAt, deletedBy };

    await publishMessage(message.id, channel.id, 'delete', tombstone);
    await relayAnnouncementDeletion(channel.id, [message.id], tombstone);

    eventBus.emit('message:deleted', {
      messageId: message.id,
      channelId: channel.id
    });
  };

  const react: PluginContext['actions']['messages']['react'] = async (
    rawInput
  ) => {
    const { message, channel } = await resolve(rawInput);
    const { emoji: rawEmoji, remove: removeReaction } = parseActionInput(
      reactSchema,
      rawInput
    );
    // The stored spelling the member routes use: a bridge relaying `👍`
    // and a member pressing the picker's +1 land on the same row.
    const emoji = normalizeReaction(rawEmoji);
    if (emoji.length === 0) {
      throw new PluginActionError('BAD_REQUEST', 'Invalid reaction');
    }
    const actorUserId = await actorIn(channel.serverId);

    const existing = await getReaction(message.id, emoji, actorUserId);
    const added = !removeReaction;

    // Explicit add/remove rather than the user route's toggle: a bridge
    // replaying "reaction added" twice must not flip it off again.
    if (added === !!existing) return;

    if (added) {
      await db.insert(messageReactions).values({
        messageId: message.id,
        emoji,
        userId: actorUserId,
        fileId: await getEmojiFileIdByEmojiName(emoji),
        createdAt: Date.now()
      });
    } else {
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, message.id),
            eq(messageReactions.emoji, emoji),
            eq(messageReactions.userId, actorUserId)
          )
        );
    }

    await publishMessage(message.id, channel.id, 'update');

    eventBus.emit('message:reaction', {
      messageId: message.id,
      channelId: channel.id,
      userId: actorUserId,
      emoji,
      added,
      pluginId
    });
  };

  return { post, edit, delete: remove, react };
};

export { createMessageActions };
