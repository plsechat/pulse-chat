import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { dmMessages } from '../../db/schema';
import { urlMetadataParser } from '../message-metadata/get-message-metadata';

export const processDmMessageMetadata = async (
  content: string,
  dmMessageId: number
) => {
  const metadata = await urlMetadataParser(content);

  if (!metadata || metadata.length === 0) return null;

  // Never onto a tombstone (see the channel twin).
  const [updatedMessage] = await db
    .update(dmMessages)
    .set({
      metadata,
      updatedAt: Date.now()
    })
    .where(and(eq(dmMessages.id, dmMessageId), isNull(dmMessages.deletedAt)))
    .returning();

  return updatedMessage;
};
