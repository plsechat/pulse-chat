import type {
  TFile,
  TJoinedMessage,
  TMessage,
  TMessageReaction
} from '@pulse/shared';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '..';
import { generateFileToken } from '../../helpers/files-crypto';
import { channels, messageFiles, messageReactions, messages } from '../schema';
import {
  fetchChannelMessageFiles,
  fetchChannelReactions,
  fetchChannelReplyTo
} from './shared-message-helpers';

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

  const rawFiles = await fetchChannelMessageFiles(messageId);

  const filesForMessage: TFile[] = channel.private
    ? rawFiles.map((f) => ({
        ...f,
        _accessToken: generateFileToken(f.id, channel.fileAccessToken)
      }))
    : rawFiles;

  const reactions = await fetchChannelReactions(messageId);
  const replyTo = await fetchChannelReplyTo(message.replyToId);

  return {
    ...message,
    files: filesForMessage,
    reactions,
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

export { getMessage, getMessageByFileId, getMessagesByUserId, getReaction };
