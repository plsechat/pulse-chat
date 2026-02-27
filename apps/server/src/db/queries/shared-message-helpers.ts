import type { TFile, TMessageReplyPreview } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '..';
import {
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  files,
  messageFiles,
  messageReactions,
  messages
} from '../schema';

/**
 * Fetch reply-to preview for a channel message.
 */
export const fetchChannelReplyTo = async (
  replyToId: number | null
): Promise<TMessageReplyPreview | null> => {
  if (!replyToId) return null;
  const [row] = await db
    .select({ id: messages.id, content: messages.content, userId: messages.userId })
    .from(messages)
    .where(eq(messages.id, replyToId))
    .limit(1);
  return row ?? null;
};

/**
 * Fetch reply-to preview for a DM message.
 */
export const fetchDmReplyTo = async (
  replyToId: number | null
): Promise<TMessageReplyPreview | null> => {
  if (!replyToId) return null;
  const [row] = await db
    .select({ id: dmMessages.id, content: dmMessages.content, userId: dmMessages.userId })
    .from(dmMessages)
    .where(eq(dmMessages.id, replyToId))
    .limit(1);
  return row ?? null;
};

/**
 * Fetch files attached to a channel message.
 */
export const fetchChannelMessageFiles = async (
  messageId: number
): Promise<TFile[]> => {
  const rows = await db
    .select({ file: files })
    .from(messageFiles)
    .innerJoin(files, eq(messageFiles.fileId, files.id))
    .where(eq(messageFiles.messageId, messageId));
  return rows.map((r) => r.file);
};

/**
 * Fetch files attached to a DM message.
 */
export const fetchDmMessageFiles = async (
  messageId: number
): Promise<TFile[]> => {
  const rows = await db
    .select({ file: files })
    .from(dmMessageFiles)
    .innerJoin(files, eq(dmMessageFiles.fileId, files.id))
    .where(eq(dmMessageFiles.dmMessageId, messageId));
  return rows.map((r) => r.file);
};

/**
 * Fetch reactions with emoji files for a channel message.
 */
export const fetchChannelReactions = async (messageId: number) => {
  const rows = await db
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

  return rows.map((r) => ({
    messageId: r.messageId,
    userId: r.userId,
    emoji: r.emoji,
    createdAt: r.createdAt,
    fileId: r.fileId,
    file: r.file
  }));
};

/**
 * Fetch reactions with emoji files for a DM message.
 */
export const fetchDmReactions = async (messageId: number) => {
  const rows = await db
    .select({
      dmMessageId: dmMessageReactions.dmMessageId,
      userId: dmMessageReactions.userId,
      emoji: dmMessageReactions.emoji,
      createdAt: dmMessageReactions.createdAt,
      fileId: dmMessageReactions.fileId,
      file: files
    })
    .from(dmMessageReactions)
    .leftJoin(files, eq(dmMessageReactions.fileId, files.id))
    .where(eq(dmMessageReactions.dmMessageId, messageId));

  return rows.map((r) => ({
    dmMessageId: r.dmMessageId,
    userId: r.userId,
    emoji: r.emoji,
    createdAt: r.createdAt,
    fileId: r.fileId,
    file: r.file
  }));
};
