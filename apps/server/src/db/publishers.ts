import {
  ChannelPermission,
  ServerEvents,
  UserStatus,
  type TChannelUserPermissionsMap
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '.';
import { pluginManager } from '../plugins';
import { pubsub } from '../utils/pubsub';
import {
  getAffectedUserIdsForChannel,
  getAllChannelUserPermissions,
  getChannelsReadStatesForUser
} from './queries/channels';
import { getEmojiById } from './queries/emojis';
import { getMessage } from './queries/messages';
import { getRole } from './queries/roles';
import { getServerPublicSettings } from './queries/server';
import { getServerMemberIds } from './queries/servers';
import { getPublicUserById } from './queries/users';
import { categories, channels } from './schema';

const publishMessage = async (
  messageId: number | undefined,
  channelId: number | undefined,
  type: 'create' | 'update' | 'delete'
) => {
  if (!messageId || !channelId) return;

  if (type === 'delete') {
    pubsub.publish(ServerEvents.MESSAGE_DELETE, {
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

  pubsub.publishFor(affectedUserIds, targetEvent, message);

  // only send count updates to users OTHER than the message author
  const usersToNotify = affectedUserIds.filter((id) => id !== message.userId);

  const promises = usersToNotify.map(async (userId) => {
    const { readStates, mentionStates } = await getChannelsReadStatesForUser(userId, channelId);
    const count = readStates[channelId] ?? 0;
    const mentionCount = mentionStates[channelId] ?? 0;

    pubsub.publishFor(userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
      channelId,
      count,
      mentionCount
    });
  });

  await Promise.all(promises);

  // Signal server-level unread increment without extra DB queries.
  // publishMessage is fire-and-forget (not awaited by callers), so heavy DB
  // queries here risk deadlocking with concurrent table operations in tests.
  // Exact counts are computed on initial join and on mark-as-read.
  if (type === 'create') {
    const [channelRow] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (channelRow) {
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
          { serverId: channelRow.serverId, count: -1, mentionCount: 0 }
        );
      }

      if (mentioned.length > 0) {
        pubsub.publishFor(
          mentioned,
          ServerEvents.SERVER_UNREAD_COUNT_UPDATE,
          { serverId: channelRow.serverId, count: -1, mentionCount: -1 }
        );
      }
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

const publishUser = async (
  userId: number | undefined,
  type: 'create' | 'update' | 'delete',
  statusOverride?: UserStatus
) => {
  if (!userId) return;

  if (type === 'delete') {
    pubsub.publish(ServerEvents.USER_DELETE, userId);
    return;
  }

  const user = await getPublicUserById(userId);

  if (!user) return;

  if (statusOverride !== undefined) {
    // Invisible should appear as offline to other users
    user.status = statusOverride === UserStatus.INVISIBLE
      ? UserStatus.OFFLINE
      : statusOverride;
  }

  const targetEvent =
    type === 'create' ? ServerEvents.USER_CREATE : ServerEvents.USER_UPDATE;

  // User updates are global (visible across servers)
  pubsub.publish(targetEvent, user);
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

  const memberIds = await getServerMemberIds(channel.serverId);
  pubsub.publishFor(memberIds, targetEvent, channel);
};

const publishSettings = async (serverId?: number) => {
  if (serverId) {
    const settings = await getServerPublicSettings(serverId);
    const memberIds = await getServerMemberIds(serverId);
    pubsub.publishFor(memberIds, ServerEvents.SERVER_SETTINGS_UPDATE, settings);
  } else {
    // Backward compat: publish to all
    const settings = await getServerPublicSettings(1);
    pubsub.publish(ServerEvents.SERVER_SETTINGS_UPDATE, settings);
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
  const permissionsMap = new Map<number, TChannelUserPermissionsMap>();
  const promises = affectedUserIds.map(async (userId) => {
    const updatedPermissions = await getAllChannelUserPermissions(userId);

    permissionsMap.set(userId, updatedPermissions);
  });

  await Promise.all(promises);

  for (const userId of affectedUserIds) {
    const updatedPermissions = permissionsMap.get(userId);

    if (!updatedPermissions) continue;

    pubsub.publishFor(
      userId,
      ServerEvents.CHANNEL_PERMISSIONS_UPDATE,
      updatedPermissions
    );
  }
};

const publishPluginCommands = async () => {
  const commands = pluginManager.getCommands();

  pubsub.publish(ServerEvents.PLUGIN_COMMANDS_CHANGE, commands);
};

export {
  publishCategory,
  publishChannel,
  publishChannelPermissions,
  publishEmoji,
  publishMessage,
  publishPluginCommands,
  publishRole,
  publishSettings,
  publishUser
};
