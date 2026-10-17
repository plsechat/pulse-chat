import type { TMessageTombstone } from '@pulse/server/types';

/**
 * Message tombstones, the client half. A deletion no longer drops the
 * row: the server keeps it with `deletedAt` + `deletedBy` and cleared
 * content, and the lists mark it in place so the row keeps its anchor
 * (jump links, reply targets) and its place in the scroll. Shared by
 * features/server/slice.ts and features/dms/slice.ts so both lists mark
 * the same way, and by the renderers for the one "who sees what"
 * decision below.
 */

type TTombstoneable = {
  id: number;
  content: string | null;
  files: unknown[];
  reactions: unknown[];
  metadata: unknown;
  mentionedUserIds?: number[] | null;
  mentionsAll?: boolean | null;
  edited: boolean;
  pinned: boolean;
  pinnedAt: number | null;
  pinnedBy: number | null;
  forwardedFromUserId: number | null;
  forwardedFromName: string | null;
  deletedAt: number | null;
  deletedBy: number | null;
  replyTo?: { id: number; content: string | null; hasFiles?: boolean } | null;
};

export const isTombstone = (message: { deletedAt?: number | null }): boolean =>
  message.deletedAt != null;

/**
 * Mark `ids` as deleted the way the server's row now reads (content and
 * everything it carried cleared) and let every reply to one of them
 * show the deleted target (its preview reads null content as "Message
 * deleted"). Rows not in `ids` are returned as they were; an unknown id
 * is a no-op.
 */
export const markTombstoned = <T extends TTombstoneable>(
  messages: T[],
  ids: Iterable<number>,
  tombstone: TMessageTombstone
): T[] => {
  const set = ids instanceof Set ? ids : new Set(ids);
  if (set.size === 0) return messages;

  return messages.map((message) => {
    if (set.has(message.id)) {
      return {
        ...message,
        content: null,
        files: [],
        reactions: [],
        metadata: null,
        mentionedUserIds: null,
        mentionsAll: false,
        edited: false,
        pinned: false,
        pinnedAt: null,
        pinnedBy: null,
        forwardedFromUserId: null,
        forwardedFromName: null,
        deletedAt: tombstone.deletedAt,
        deletedBy: tombstone.deletedBy
      };
    }

    if (message.replyTo && set.has(message.replyTo.id)) {
      return {
        ...message,
        replyTo: { ...message.replyTo, content: null, hasFiles: false }
      };
    }

    return message;
  });
};

export type TTombstoneAudit = {
  /** The deleter's display name, or null when no local account did it. */
  deleterName: string | null;
  deletedAt: number;
};

/**
 * Everyone sees "Message deleted"; who deleted it and when is for
 * moderators only (MANAGE_MESSAGES in the channel's server) — a member
 * learns nothing about who removed what. Returns null when the row is
 * not a tombstone or the viewer may not see the audit line. A tombstone
 * whose deleter is unknown (deleted on a peer instance, or an account
 * since removed) still shows moderators the time.
 */
export const tombstoneAudit = (
  message: { deletedAt?: number | null; deletedBy?: number | null },
  canSeeAudit: boolean,
  deleterName: string | null | undefined
): TTombstoneAudit | null => {
  if (message.deletedAt == null || !canSeeAudit) return null;

  return {
    deleterName: message.deletedBy != null ? (deleterName ?? null) : null,
    deletedAt: message.deletedAt
  };
};
