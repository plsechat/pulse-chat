import { ChannelPermission, ChannelType } from '@pulse/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { publishChannelPermissions } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import {
  channelRolePermissions,
  channelUserPermissions,
  channels,
  forumTags
} from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { invalidatePermissionCacheForUser } from '../../utils/permission-cache-registry';

/** Tags per post — a post carries a handful of labels, not a taxonomy. */
const MAX_TAGS_PER_POST = 20;

/** Temp ids are UUIDs, never longer (the count cap lives in @pulse/shared). */
const MAX_TEMP_FILE_ID_LENGTH = 64;

type TThreadParent = typeof channels.$inferSelect;

/**
 * A thread may only hang off a TEXT or FORUM channel. Voice channels have
 * no messages to thread, and a thread under a thread would escape the
 * parent-derived visibility below.
 */
const assertThreadableParent = (parent: TThreadParent) => {
  invariant(
    parent.type === ChannelType.TEXT || parent.type === ChannelType.FORUM,
    {
      code: 'BAD_REQUEST',
      message: 'Threads can only be created in text or forum channels'
    }
  );
};

/**
 * Every tag id must be one of the forum's own tags — tags from another
 * forum (or another server) would otherwise be attached and rendered via
 * the join in get-threads. Duplicates are collapsed so the PK on
 * forum_post_tags never surfaces as a raw DB error.
 */
const resolveForumTagIds = async (
  forumChannelId: number,
  tagIds: number[] | undefined
): Promise<number[]> => {
  const unique = [...new Set(tagIds ?? [])];

  if (unique.length === 0) return [];

  const rows = await db
    .select({ id: forumTags.id })
    .from(forumTags)
    .where(
      and(
        eq(forumTags.channelId, forumChannelId),
        inArray(forumTags.id, unique)
      )
    );

  invariant(rows.length === unique.length, {
    code: 'BAD_REQUEST',
    message: 'One or more tags do not belong to this forum'
  });

  return unique;
};

/**
 * Visibility of a private channel lives entirely in its own override
 * rows (channel_role_permissions / channel_user_permissions); nothing
 * is inherited at check time. A thread created under a private parent
 * therefore copies the parent's overrides so exactly the parent's
 * viewers can see it — without this the thread would be visible to the
 * server owner alone. Runs inside the creation transaction.
 */
const copyParentOverrides = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentChannelId: number,
  threadId: number,
  now: number
) => {
  const [roleRows, userRows] = await Promise.all([
    tx
      .select({
        roleId: channelRolePermissions.roleId,
        permission: channelRolePermissions.permission,
        allow: channelRolePermissions.allow
      })
      .from(channelRolePermissions)
      .where(eq(channelRolePermissions.channelId, parentChannelId)),
    tx
      .select({
        userId: channelUserPermissions.userId,
        permission: channelUserPermissions.permission,
        allow: channelUserPermissions.allow
      })
      .from(channelUserPermissions)
      .where(eq(channelUserPermissions.channelId, parentChannelId))
  ]);

  if (roleRows.length > 0) {
    await tx.insert(channelRolePermissions).values(
      roleRows.map((r) => ({ ...r, channelId: threadId, createdAt: now }))
    );
  }

  if (userRows.length > 0) {
    await tx.insert(channelUserPermissions).values(
      userRows.map((u) => ({ ...u, channelId: threadId, createdAt: now }))
    );
  }
};

/**
 * Who should receive THREAD_* events for a thread: everyone who can view
 * it. For a public thread that is every server member (unchanged
 * behaviour); for a private one it is the override holders + owner.
 */
const getThreadViewerIds = (threadId: number) =>
  getAffectedUserIdsForChannel(threadId, {
    permission: ChannelPermission.VIEW_CHANNEL
  });

/**
 * After a private thread is created its viewers' channel-permission maps
 * gain a new entry. Every live connection of those users caches the map
 * lazily (utils/wss.ts), so drop those caches first — the creator's own
 * connection otherwise still denies the thread it just made — then push
 * the refreshed maps so clients can open it without a reload. No-op for
 * public threads (nothing to refresh).
 */
const publishPrivateThreadPermissions = async (
  isPrivate: boolean,
  viewerIds: number[]
) => {
  if (!isPrivate || viewerIds.length === 0) return;
  for (const userId of viewerIds) invalidatePermissionCacheForUser(userId);
  await publishChannelPermissions(viewerIds);
};

export {
  assertThreadableParent,
  copyParentOverrides,
  getThreadViewerIds,
  MAX_TAGS_PER_POST,
  MAX_TEMP_FILE_ID_LENGTH,
  publishPrivateThreadPermissions,
  resolveForumTagIds
};
