import type { TAnnouncementRow } from '@pulse/server/types';

/**
 * An announcement copy is a `type: 'system'` row whose content is a
 * TAnnouncementRow document. Recognised by its exact shape; anything
 * else is left to the other system-row renderers.
 */
export const parseAnnouncementRow = (
  content: string | null | undefined
): TAnnouncementRow | null => {
  if (!content || content[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.kind !== 'announcement') return null;
  const source = row.source as Record<string, unknown> | undefined;
  const author = row.author as Record<string, unknown> | undefined;
  if (
    typeof row.sourceKey !== 'string' ||
    typeof row.content !== 'string' ||
    !source ||
    typeof source.channelName !== 'string' ||
    typeof source.serverName !== 'string' ||
    !author ||
    typeof author.name !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'announcement',
    sourceKey: row.sourceKey,
    source: {
      domain: typeof source.domain === 'string' ? source.domain : null,
      serverPublicId: typeof source.serverPublicId === 'string' ? source.serverPublicId : '',
      serverName: source.serverName,
      channelPublicId: typeof source.channelPublicId === 'string' ? source.channelPublicId : '',
      channelName: source.channelName
    },
    messageId: typeof row.messageId === 'number' ? row.messageId : 0,
    content: row.content,
    author: {
      publicId: typeof author.publicId === 'string' ? author.publicId : '',
      name: author.name,
      avatarUrl: typeof author.avatarUrl === 'string' ? author.avatarUrl : null
    },
    edited: row.edited === true
  };
};
