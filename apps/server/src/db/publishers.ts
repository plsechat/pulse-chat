import {
  ChannelPermission,
  ChannelType,
  ServerEvents,
  UserStatus
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '.';
import { logger } from '../logger';
import { pluginManager } from '../plugins';
import { pubsub } from '../utils/pubsub';
import {
  getAffectedUserIdsForChannel,
  getAllChannelUserPermissions,
  getChannelUnreadForUsers,
  getForumUnreadForUsers
} from './queries/channels';
import { getEmojiById } from './queries/emojis';
import { getMessage } from './queries/messages';
import { getRole } from './queries/roles';
import {
  getPresenceInterestedIds,
  getServerMemberIds
} from './queries/servers';
import { getPublicUserById } from './queries/users';
import { categories, channels, servers, threadFollowers } from './schema';
import { toWireChannel } from './queries/channels';

const publishMessage = async (
  messageId: number | undefined,
  channelId: number | undefined,
  type: 'create' | 'update' | 'delete'
) => {
  if (!messageId || !channelId) return;

  try {
    return await _publishMessageInner(messageId, channelId, type);
  } catch (err) {
    logger.error('[publishMessage] failed for message %d channel %d:', messageId, channelId, err);
  }
};

const _publishMessageInner = async (
  messageId: number,
  channelId: number,
  type: 'create' | 'update' | 'delete'
) => {
  if (type === 'delete') {
    const deleteAffected = await getAffectedUserIdsForChannel(channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    pubsub.publishFor(deleteAffected, ServerEvents.MESSAGE_DELETE, {
      messageId: messageId,
      channelId: channelId
    });

    return;
  }

  const message = await getMessage(messageId);

  if (!message) return;

  const targetEvent =
    type === 'create' ? ServerEvents.NEW_MESSAGE : ServerEvents.MESSAGE_UPDATE;

  const affectedUserIds = await getAffectedUserIdsForChannel(channelId, {
    permission: ChannelPermission.VIEW_CHANNEL
  });

  // Check if this is a forum thread — if so, only publish to followers + mentioned
  const [channelInfo] = await db
    .select({
      type: channels.type,
      parentChannelId: channels.parentChannelId,
      serverId: channels.serverId
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  let forumParentId: number | null = null;
  let messageRecipients = affectedUserIds;

  if (channelInfo?.type === ChannelType.THREAD && channelInfo.parentChannelId) {
    const [parentInfo] = await db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelInfo.parentChannelId))
      .limit(1);

    if (parentInfo?.type === ChannelType.FORUM) {
      forumParentId = channelInfo.parentChannelId;

      const followers = await db
        .select({ userId: threadFollowers.userId })
        .from(threadFollowers)
        .where(eq(threadFollowers.threadId, channelId));

      const followerIds = new Set(followers.map((f) => f.userId));
      const mentionedSet = new Set<number>(
        (message.mentionedUserIds as number[] | null) ?? []
      );

      // Only deliver the message event to the author, followers, and mentioned users
      messageRecipients = affectedUserIds.filter(
        (id) => id === message.userId || followerIds.has(id) || mentionedSet.has(id)
      );
    }
  }

  pubsub.publishFor(messageRecipients, targetEvent, message);

  // only send count updates to users OTHER than the message author
  const usersToNotify = messageRecipients.filter((id) => id !== message.userId);

  // One grouped statement for every recipient (a user with no read-state
  // row, or no newer messages, is simply absent and reads as 0/0) — the
  // per-recipient aggregate this replaced was O(members x messages) per
  // message. The query count here is independent of the recipient count.
  const unreadByUser = await getChannelUnreadForUsers(usersToNotify, channelId);

  for (const userId of usersToNotify) {
    const counts = unreadByUser.get(userId);

    pubsub.publishFor(userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
      channelId,
      count: counts?.count ?? 0,
      mentionCount: counts?.mentionCount ?? 0
    });
  }

  // Also update the parent forum channel's aggregated unread count
  if (forumParentId) {
    const forumByUser = await getForumUnreadForUsers(usersToNotify, forumParentId);

    for (const userId of usersToNotify) {
      const counts = forumByUser.get(userId);

      pubsub.publishFor(userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
        channelId: forumParentId,
        count: counts?.count ?? 0,
        mentionCount: counts?.mentionCount ?? 0
      });
    }
  }

  // Signal server-level unread increment without extra DB queries.
  // publishMessage is fire-and-forget (not awaited by callers), so heavy DB
  // queries here risk deadlocking with concurrent table operations in tests.
  // Exact counts are computed on initial join and on mark-as-read.
  if (type === 'create' && channelInfo) {
    // Determine which users have direct mentions (not @all) for the red server badge
    const directMentionedSet = new Set<number>(
      message.mentionedUserIds && !message.mentionsAll
        ? (message.mentionedUserIds as number[]).filter((id) => id !== message.userId)
        : []
    );

    const nonMentioned = usersToNotify.filter((id) => !directMentionedSet.has(id));
    const mentioned = usersToNotify.filter((id) => directMentionedSet.has(id));

    if (nonMentioned.length > 0) {
      pubsub.publishFor(
        nonMentioned,
        ServerEvents.SERVER_UNREAD_COUNT_UPDATE,
        { serverId: channelInfo.serverId, count: -1, mentionCount: 0 }
      );
    }

    if (mentioned.length > 0) {
      pubsub.publishFor(
        mentioned,
        ServerEvents.SERVER_UNREAD_COUNT_UPDATE,
        { serverId: channelInfo.serverId, count: -1, mentionCount: -1 }
      );
    }
  }
};

const publishEmoji = async (
  emojiId: number | undefined,
  type: 'create' | 'update' | 'delete',
  serverId?: number
) => {
  if (!emojiId) return;

  if (type === 'delete') {
    if (!serverId) return;
    const memberIds = await getServerMemberIds(serverId);
    pubsub.publishFor(memberIds, ServerEvents.EMOJI_DELETE, emojiId);
    return;
  }

  const emoji = await getEmojiById(emojiId);

  if (!emoji) return;

  const targetEvent =
    type === 'create' ? ServerEvents.EMOJI_CREATE : ServerEvents.EMOJI_UPDATE;

  const memberIds = await getServerMemberIds(emoji.serverId);
  pubsub.publishFor(memberIds, targetEvent, emoji);
};

const publishRole = async (
  roleId: number | undefined,
  type: 'create' | 'update' | 'delete',
  serverId?: number
) => {
  if (!roleId) return;

  if (type === 'delete') {
    if (!serverId) return;
    const memberIds = await getServerMemberIds(serverId);
    pubsub.publishFor(memberIds, ServerEvents.ROLE_DELETE, roleId);
    return;
  }

  const role = await getRole(roleId);

  if (!role) return;

  const targetEvent =
    type === 'create' ? ServerEvents.ROLE_CREATE : ServerEvents.ROLE_UPDATE;

  const memberIds = await getServerMemberIds(role.serverId);
  pubsub.publishFor(memberIds, targetEvent, role);
};

/**
 * Fan a user-related event to interested clients.
 *
 * - `scopeServerId` set: server-scoped event (kick/ban/leave). Recipients are
 *   the members of that server (plus the user themselves so their own client
 *   can react). For type='delete' the payload includes the serverId so
 *   clients can ignore it when viewing a different server — without that
 *   filter, a kick in server A would clear user X from the local roster of
 *   server B (audit H1).
 * - `scopeServerId` unset: global event (profile / status / account-create).
 *   Recipients are every co-member across every shared server. type='delete'
 *   without a scope is rejected — there is no current "globally remove from
 *   every roster" use case and silently fanning out would re-introduce the
 *   pre-fix bleed.
 */
const publishUser = async (
  userId: number | undefined,
  type: 'create' | 'update' | 'delete',
  opts?: { scopeServerId?: number; statusOverride?: UserStatus }
) => {
  if (!userId) return;

  const scopeServerId = opts?.scopeServerId;

  if (type === 'delete' && scopeServerId === undefined) {
    logger.warn(
      `[publishUser] delete called without scopeServerId for user ${userId} — skipping to avoid cross-server fanout`
    );
    return;
  }

  // Global events (profile/status) reach everyone with a presence
  // interest — server co-members, DM partners, and friends — not just
  // co-members. DM-only contacts and friends previously never received
  // status or profile updates.
  const baseRecipients = scopeServerId
    ? await getServerMemberIds(scopeServerId)
    : await getPresenceInterestedIds(userId);
  const recipients = Array.from(new Set([...baseRecipients, userId]));

  if (type === 'delete') {
    // Include the globally-unique publicId so clients can scope the event —
    // the numeric serverId collides across federated instances.
    const [scopeServer] = await db
      .select({ publicId: servers.publicId })
      .from(servers)
      .where(eq(servers.id, scopeServerId!))
      .limit(1);

    pubsub.publishFor(recipients, ServerEvents.USER_DELETE, {
      serverId: scopeServerId!,
      serverPublicId: scopeServer?.publicId,
      userId
    });
    return;
  }

  const user = await getPublicUserById(userId);

  if (!user) return;

  if (opts?.statusOverride !== undefined) {
    // Invisible should appear as offline to other users
    user.status =
      opts.statusOverride === UserStatus.INVISIBLE
        ? UserStatus.OFFLINE
        : opts.statusOverride;
  }

  const targetEvent =
    type === 'create' ? ServerEvents.USER_CREATE : ServerEvents.USER_UPDATE;

  pubsub.publishFor(recipients, targetEvent, user);
};

/**
 * Who may see a channel right now: every member for a public channel,
 * only VIEW_CHANNEL holders for a private one (owner included).
 */
const getChannelViewerIds = async (channel: {
  id: number;
  serverId: number;
  private: boolean;
}): Promise<{ viewers: number[]; others: number[] }> => {
  const memberIds = await getServerMemberIds(channel.serverId);
  if (!channel.private) return { viewers: memberIds, others: [] };

  const viewers = await getAffectedUserIdsForChannel(channel.id, {
    permission: ChannelPermission.VIEW_CHANNEL
  });
  const viewerSet = new Set(viewers);
  return {
    viewers,
    others: memberIds.filter((id) => !viewerSet.has(id))
  };
};

/**
 * Re-sync a channel's presence on every member's client after something
 * changed who may view it (privacy flag flipped, an override added or
 * removed): viewers get the row (CHANNEL_CREATE is an idempotent upsert
 * on the client, so members who never had the channel gain it), everyone
 * else gets CHANNEL_DELETE so the channel leaves their sidebar live.
 */
const publishChannelVisibility = async (channelId: number) => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) return;

  const { viewers, others } = await getChannelViewerIds(channel);
  pubsub.publishFor(viewers, ServerEvents.CHANNEL_CREATE, toWireChannel(channel));
  if (others.length > 0) {
    pubsub.publishFor(others, ServerEvents.CHANNEL_DELETE, channelId);
  }
};

const publishChannel = async (
  channelId: number | undefined,
  type: 'create' | 'update' | 'delete',
  serverId?: number
) => {
  if (!channelId) return;

  if (type === 'delete') {
    if (!serverId) return;
    const memberIds = await getServerMemberIds(serverId);
    pubsub.publishFor(memberIds, ServerEvents.CHANNEL_DELETE, channelId);
    return;
  }

  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) return;

  const targetEvent =
    type === 'create'
      ? ServerEvents.CHANNEL_CREATE
      : ServerEvents.CHANNEL_UPDATE;

  // A private channel's row (name, topic, position) only goes to the
  // members who can view it; a public one to every member. On update,
  // members outside the viewer set are told the channel is gone for them
  // (a public→private flip is otherwise invisible to the people it hides
  // the channel from).
  const { viewers, others } = await getChannelViewerIds(channel);
  pubsub.publishFor(viewers, targetEvent, toWireChannel(channel));
  if (type === 'update' && others.length > 0) {
    pubsub.publishFor(others, ServerEvents.CHANNEL_DELETE, channelId);
  }
};

const publishCategory = async (
  categoryId: number | undefined,
  type: 'create' | 'update' | 'delete',
  serverId?: number
) => {
  if (!categoryId) return;

  if (type === 'delete') {
    if (!serverId) return;
    const memberIds = await getServerMemberIds(serverId);
    pubsub.publishFor(memberIds, ServerEvents.CATEGORY_DELETE, categoryId);
    return;
  }

  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);

  if (!category) return;

  const targetEvent =
    type === 'create'
      ? ServerEvents.CATEGORY_CREATE
      : ServerEvents.CATEGORY_UPDATE;

  const memberIds = await getServerMemberIds(category.serverId);
  pubsub.publishFor(memberIds, targetEvent, category);
};

const publishChannelPermissions = async (affectedUserIds: number[]) => {
  // Process in batches to avoid overwhelming the DB with concurrent queries
  const BATCH_SIZE = 20;

  for (let i = 0; i < affectedUserIds.length; i += BATCH_SIZE) {
    const batch = affectedUserIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (userId) => {
        const updatedPermissions = await getAllChannelUserPermissions(userId);
        pubsub.publishFor(userId, ServerEvents.CHANNEL_PERMISSIONS_UPDATE, updatedPermissions);
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('[publishChannelPermissions] failed for a user:', result.reason);
      }
    }
  }
};

const publishPluginCommands = async () => {
  const commands = pluginManager.getCommands();

  pubsub.publish(ServerEvents.PLUGIN_COMMANDS_CHANGE, commands);
};

/**
 * Publishers are fire-and-forget fan-out — callers neither await nor
 * catch them. An internal query losing a deadlock (e.g. against the
 * test harness's between-test TRUNCATE, or any future lock contention)
 * must surface as a logged error, never as an unhandled rejection.
 * publishMessage already guards internally; this wraps the rest at the
 * export boundary.
 */
const swallowRejection = <A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>
): ((...args: A) => Promise<R | undefined>) => {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.error('[%s] failed:', name, err);
      return undefined;
    }
  };
};

const guardedPublishCategory = swallowRejection('publishCategory', publishCategory);
const guardedPublishChannel = swallowRejection('publishChannel', publishChannel);
const guardedPublishChannelVisibility = swallowRejection(
  'publishChannelVisibility',
  publishChannelVisibility
);
const guardedPublishChannelPermissions = swallowRejection(
  'publishChannelPermissions',
  publishChannelPermissions
);
const guardedPublishEmoji = swallowRejection('publishEmoji', publishEmoji);
const guardedPublishPluginCommands = swallowRejection(
  'publishPluginCommands',
  publishPluginCommands
);
const guardedPublishRole = swallowRejection('publishRole', publishRole);
const guardedPublishUser = swallowRejection('publishUser', publishUser);

export {
  guardedPublishCategory as publishCategory,
  guardedPublishChannel as publishChannel,
  guardedPublishChannelVisibility as publishChannelVisibility,
  guardedPublishChannelPermissions as publishChannelPermissions,
  guardedPublishEmoji as publishEmoji,
  publishMessage,
  guardedPublishPluginCommands as publishPluginCommands,
  guardedPublishRole as publishRole,
  guardedPublishUser as publishUser
};
