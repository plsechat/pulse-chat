import type { TGenericObject, TMessageMetadata } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { getLinkPreview } from 'link-preview-js';
import { db } from '../../db';
import { messages } from '../../db/schema';
import { validateFederationUrl } from '../../utils/validate-url';

const metadataCache = new Map<string, TGenericObject>();

setInterval(
  () => metadataCache.clear(),
  1000 * 60 * 60 * 2 // clear cache every 2 hours
);

export const urlMetadataParser = async (
  content: string
): Promise<TMessageMetadata[]> => {
  try {
    const urls = content
      .match(/(https?:\/\/[^\s]+)/g)
      ?.filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((url) => {
        try {
          const parsed = new URL(url);
          // Block giphy domains by checking the registered domain
          const parts = parsed.hostname.split('.');
          const baseDomain = parts.slice(-2).join('.');
          return baseDomain !== 'giphy.com';
        } catch {
          return false;
        }
      });

    if (!urls) return [];

    const promises = urls.map(async (url) => {
      if (metadataCache.has(url)) return metadataCache.get(url);

      // Validate URL is not targeting internal/private resources
      try {
        await validateFederationUrl(url);
      } catch {
        return;
      }

      const metadata = await getLinkPreview(url);

      if (!metadata) return;

      metadataCache.set(url, metadata);

      return metadata;
    });

    const metadata = (await Promise.all(promises)) as TMessageMetadata[]; // TODO: fix these types

    return metadata ?? [];
  } catch {
    // ignore
  }

  return [];
};

export const processMessageMetadata = async (
  content: string,
  messageId: number
) => {
  const metadata = await urlMetadataParser(content);

  const [updatedMessage] = await db
    .update(messages)
    .set({
      metadata,
      updatedAt: Date.now()
    })
    .where(eq(messages.id, messageId))
    .returning();

  return updatedMessage;
};
