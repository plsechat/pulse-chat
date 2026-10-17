import { eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '..';
import type { TChannelFollowView, TFollowEndpoint } from '../../types';
import { channelFollows, channels, federationInstances, servers } from '../schema';

const sourceChannel = alias(channels, 'source_channel');
const targetChannel = alias(channels, 'target_channel');
const sourceServer = alias(servers, 'source_server');
const targetServer = alias(servers, 'target_server');
const sourceInstance = alias(federationInstances, 'source_instance');
const targetInstance = alias(federationInstances, 'target_instance');

type TFollowJoin = {
  follow: typeof channelFollows.$inferSelect;
  sourceChannel: { id: number; name: string; serverId: number; publicId: string } | null;
  sourceServer: { name: string } | null;
  targetChannel: { id: number; name: string; serverId: number; publicId: string } | null;
  targetServer: { name: string } | null;
  sourceInstance: { domain: string } | null;
  targetInstance: { domain: string } | null;
};

const endpoint = (
  channel: { id: number; name: string; serverId: number } | null,
  server: { name: string } | null,
  instance: { domain: string } | null,
  publicId: string | null
): TFollowEndpoint | null => {
  if (channel) {
    return {
      kind: 'local',
      channelId: channel.id,
      channelName: channel.name,
      serverId: channel.serverId,
      serverName: server?.name ?? ''
    };
  }
  if (instance && publicId) {
    return {
      kind: 'remote',
      domain: instance.domain,
      channelPublicId: publicId,
      channelName: null,
      serverName: null
    };
  }
  return null;
};

const toView = (row: TFollowJoin): TChannelFollowView | null => {
  const source = endpoint(
    row.sourceChannel,
    row.sourceServer,
    row.sourceInstance,
    row.follow.sourceChannelPublicId
  );
  const target = endpoint(
    row.targetChannel,
    row.targetServer,
    row.targetInstance,
    row.follow.targetChannelPublicId
  );
  if (!source || !target) return null;
  return { id: row.follow.id, createdAt: row.follow.createdAt, source, target };
};

const selectJoined = () =>
  db
    .select({
      follow: channelFollows,
      sourceChannel: {
        id: sourceChannel.id,
        name: sourceChannel.name,
        serverId: sourceChannel.serverId,
        publicId: sourceChannel.publicId
      },
      sourceServer: { name: sourceServer.name },
      targetChannel: {
        id: targetChannel.id,
        name: targetChannel.name,
        serverId: targetChannel.serverId,
        publicId: targetChannel.publicId
      },
      targetServer: { name: targetServer.name },
      sourceInstance: { domain: sourceInstance.domain },
      targetInstance: { domain: targetInstance.domain }
    })
    .from(channelFollows)
    .leftJoin(sourceChannel, eq(channelFollows.sourceChannelId, sourceChannel.id))
    .leftJoin(sourceServer, eq(sourceChannel.serverId, sourceServer.id))
    .leftJoin(targetChannel, eq(channelFollows.targetChannelId, targetChannel.id))
    .leftJoin(targetServer, eq(targetChannel.serverId, targetServer.id))
    .leftJoin(sourceInstance, eq(channelFollows.sourceInstanceId, sourceInstance.id))
    .leftJoin(targetInstance, eq(channelFollows.targetInstanceId, targetInstance.id));

/**
 * Both relations of one channel: what it follows (it is the target)
 * and who follows it (it is the source), each with the other side
 * named — local channel + server, or peer domain + public id.
 */
const listFollowsForChannel = async (
  channelId: number
): Promise<{ following: TChannelFollowView[]; followers: TChannelFollowView[] }> => {
  const rows = await selectJoined().where(
    or(eq(channelFollows.targetChannelId, channelId), eq(channelFollows.sourceChannelId, channelId))
  );

  const following: TChannelFollowView[] = [];
  const followers: TChannelFollowView[] = [];

  for (const row of rows) {
    const view = toView(row as TFollowJoin);
    if (!view) continue;
    if (row.follow.targetChannelId === channelId) following.push(view);
    if (row.follow.sourceChannelId === channelId) followers.push(view);
  }

  return { following, followers };
};

/** One follow with its joined sides, for the unfollow route's scope check. */
const getFollowJoined = async (followId: number): Promise<TFollowJoin | undefined> => {
  const [row] = await selectJoined().where(eq(channelFollows.id, followId)).limit(1);
  return row as TFollowJoin | undefined;
};

export { getFollowJoined, listFollowsForChannel };
