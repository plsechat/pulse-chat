import type {
  TFile,
  TJoinedMessage,
  TJoinedMessageReaction,
  TMessage,
  TMessageReaction
} from '@pulse/shared';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '..';
import { generateFileToken } from '../../helpers/files-crypto';
import {
  channels,
  files,
  messageFiles,
  messageReactions,
  messages
} from '../schema';

const getMessageByFileId = async (
  fileId: number
): Promise<TMessage | undefined> => {
  const [row] = await db
    .select({ message: messages })
    .from(messageFiles)
    .innerJoin(messages, eq(messages.id, messageFiles.messageId))
    .where(eq(messageFiles.fileId, fileId))
    .limit(1);

  return row?.message;
};

/**
 * Fetch a single message scoped to a server. Returns undefined if the
 * message doesn't exist OR belongs to a channel in a different server —
 * callers treat both cases as "not found" so a user with the matching
 * permission in server B can't read/mutate messages from server A by
 * id (audit recurring rule: pulse-rule-cross-server-scope). Replaces
 * the 5-site inline `select.from(messages).innerJoin(channels)` pattern
 * across pin/unpin/delete/edit/toggle-reaction.
 */
const getMessageInActiveServer = async (
  messageId: number,
  serverId: number
): Promise<TMessage | undefined> => {
  const [row] = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(and(eq(messages.id, messageId), eq(channels.serverId, serverId)))
    .limit(1);

  return row?.message;
};

const getMessage = async (
  messageId: number
): Promise<TJoinedMessage | undefined> => {
  const [message] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!message) return undefined;

  const [channel] = await db
    .select({
      fileAccessToken: channels.fileAccessToken,
      private: channels.private
    })
    .from(channels)
    .where(eq(channels.id, message.channelId))
    .limit(1);

  if (!channel) return undefined;

  const fileRows = await db
    .select({
      file: files
    })
    .from(messageFiles)
    .innerJoin(files, eq(messageFiles.fileId, files.id))
    .where(eq(messageFiles.messageId, messageId));

  const filesForMessage: TFile[] = fileRows.map((r) => {
    if (channel.private) {
      return {
        ...r.file,
        _accessToken: generateFileToken(r.file.id, channel.fileAccessToken)
      };
    }

    return r.file;
  });

  const reactionRows = await db
    .select({
      messageId: messageReactions.messageId,
      userId: messageReactions.userId,
      emoji: messageReactions.emoji,
      createdAt: messageReactions.createdAt,
      fileId: messageReactions.fileId,
      file: files
    })
    .from(messageReactions)
    .leftJoin(files, eq(messageReactions.fileId, files.id))
    .where(eq(messageReactions.messageId, messageId));

  const reactions: TJoinedMessageReaction[] = reactionRows.map((r) => ({
    messageId: r.messageId,
    userId: r.userId,
    emoji: r.emoji,
    createdAt: r.createdAt,
    fileId: r.fileId,
    file: r.file
  }));

  let replyTo: TJoinedMessage['replyTo'] = null;

  if (message.replyToId) {
    const [replyRow] = await db
      .select({
        id: messages.id,
        content: messages.content,
        userId: messages.userId
      })
      .from(messages)
      .where(eq(messages.id, message.replyToId))
      .limit(1);

    if (replyRow) {
      const [hasFileRow] = await db
        .select({ messageId: messageFiles.messageId })
        .from(messageFiles)
        .where(eq(messageFiles.messageId, message.replyToId))
        .limit(1);

      replyTo = {
        ...replyRow,
        hasFiles: !!hasFileRow
      };
    }
  }

  return {
    ...message,
    files: filesForMessage ?? [],
    reactions: reactions ?? [],
    replyTo
  };
};

const getMessagesByUserId = async (userId: number): Promise<TMessage[]> =>
  db
    .select()
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(desc(messages.createdAt));

const getReaction = async (
  messageId: number,
  emoji: string,
  userId: number
): Promise<TMessageReaction | undefined> => {
  const [reaction] = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.emoji, emoji),
        eq(messageReactions.userId, userId)
      )
    )
    .limit(1);

  return reaction;
};

export {
  getMessage,
  getMessageByFileId,
  getMessageInActiveServer,
  getMessagesByUserId,
  getReaction
};
