/**
 * Announcement follow across instances — the receiver side of
 * utils/announcement-follow.ts.
 *
 * POST /federation/announcement-follow (signed):
 *   { action: 'follow' | 'unfollow',          // follower → source
 *     serverPublicId, channelPublicId,        // OUR server + announcement channel
 *     targetChannelPublicId,                  // the peer's follower channel
 *     targetChannelName?, targetServerName? }
 *   { action: 'removed',                      // source → follower
 *     channelPublicId, targetChannelPublicId } // the peer dropped us
 *
 *   'follow' records the remote follower on the source's instance
 *   (`channel_follows` with target_instance_id + target_channel_public_id)
 *   when the server is federatable and the channel a public announcement
 *   channel; anything else is `200 { ignored: 'not_followable' }` so the
 *   peer's route refuses in the same click. 'unfollow' and 'removed'
 *   delete the matching row. All three are idempotent.
 *
 * POST /federation/announcement (signed, from the source's instance):
 *   { action: 'create' | 'update', sourceServerPublicId, sourceServerName,
 *     sourceChannelPublicId, sourceChannelName, targetChannelPublicId,
 *     messageId, content, edited, author: { publicId, name, avatar? } }
 *   { action: 'delete', sourceChannelPublicId, targetChannelPublicId,
 *     messageIds: number[] }
 *
 *   Applied only when OUR row says the target channel follows that
 *   source on that peer (`200 { ignored: 'not_following' }` otherwise —
 *   a peer cannot write into a channel that never followed it). The
 *   author materialises as a shadow user (publicId-keyed, like every
 *   remote user) and the copy is addressed by sourceKey, so a replayed
 *   relay lands on the existing row.
 */

import { ChannelType, MAX_MESSAGE_CONTENT_LENGTH } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import {
  findOrCreateShadowUserByPublicId,
  syncShadowUserAvatar
} from '../db/mutations/federation';
import { channelFollows, channels, servers } from '../db/schema';
import { logger } from '../logger';
import type { TAnnouncementRow } from '../types';
import {
  publishFollowsUpdate,
  remoteSourceKey,
  tombstoneAnnouncementCopies,
  updateAnnouncementCopies,
  upsertAnnouncementCopy
} from '../utils/announcement-follow';
import { signedJsonResponse } from '../utils/federation';
import { getFederationProtocol } from '../utils/validate-url';
import {
  authorizeFederationRequest,
  isPeerPublicId,
  jsonResponse,
  MAX_PEER_NAME_LENGTH,
  MAX_PEER_SERVER_NAME_LENGTH,
  peerFileName,
  peerInteger,
  peerString
} from './federation-helpers';

/** Message ids one deletion carries — mirrors the sender's slice. */
const MAX_DELETE_IDS = 100;
const MAX_MESSAGE_ID = 2 ** 31 - 1;

/** A local announcement channel by its public id, with its server's public id. */
const findLocalSource = async (channelPublicId: string) => {
  const [row] = await db
    .select({
      channel: {
        id: channels.id,
        name: channels.name,
        type: channels.type,
        private: channels.private,
        announcement: channels.announcement
      },
      server: {
        publicId: servers.publicId,
        name: servers.name,
        federatable: servers.federatable
      }
    })
    .from(channels)
    .innerJoin(servers, eq(channels.serverId, servers.id))
    .where(eq(channels.publicId, channelPublicId))
    .limit(1);
  return row;
};

const federationAnnouncementFollowHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const action = signedBody.action;
  const channelPublicId = signedBody.channelPublicId;
  const targetChannelPublicId = signedBody.targetChannelPublicId;

  if (action !== 'follow' && action !== 'unfollow' && action !== 'removed') {
    return jsonResponse(res, 400, { error: 'Invalid action' });
  }
  if (!isPeerPublicId(channelPublicId) || !isPeerPublicId(targetChannelPublicId)) {
    return jsonResponse(res, 400, { error: 'Missing channel ids' });
  }

  if (action === 'removed') {
    // The peer is the SOURCE and dropped our follower channel: the row
    // we hold for it goes, so the Follows tab stops listing a follow
    // that no longer delivers.
    const [target] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.publicId, targetChannelPublicId))
      .limit(1);

    if (target) {
      const gone = await db
        .delete(channelFollows)
        .where(
          and(
            eq(channelFollows.sourceInstanceId, instance.id),
            eq(channelFollows.sourceChannelPublicId, channelPublicId),
            eq(channelFollows.targetChannelId, target.id)
          )
        )
        .returning({ id: channelFollows.id });
      if (gone.length > 0) void publishFollowsUpdate(target.id);
    }

    return signedJsonResponse(res, 200, { success: true }, fromDomain);
  }

  const source = await findLocalSource(channelPublicId);
  const serverPublicId = signedBody.serverPublicId;

  if (action === 'unfollow') {
    if (source) {
      const gone = await db
        .delete(channelFollows)
        .where(
          and(
            eq(channelFollows.sourceChannelId, source.channel.id),
            eq(channelFollows.targetInstanceId, instance.id),
            eq(channelFollows.targetChannelPublicId, targetChannelPublicId)
          )
        )
        .returning({ id: channelFollows.id });
      if (gone.length > 0) void publishFollowsUpdate(source.channel.id);
    }
    return signedJsonResponse(res, 200, { success: true }, fromDomain);
  }

  // 'follow': the channel must be what the policy allows anyone on a
  // peer to subscribe to — a public announcement channel of a server
  // this instance federates. Existence is never disclosed by status.
  const followable =
    source !== undefined &&
    isPeerPublicId(serverPublicId) &&
    source.server.publicId === serverPublicId &&
    source.server.federatable &&
    source.channel.announcement &&
    source.channel.type === ChannelType.TEXT &&
    !source.channel.private;

  if (!followable) {
    logger.debug('[announcement-follow] refused follow from %s: not followable', fromDomain);
    return signedJsonResponse(res, 200, { ignored: 'not_followable' }, fromDomain);
  }

  const inserted = await db
    .insert(channelFollows)
    .values({
      sourceChannelId: source.channel.id,
      targetInstanceId: instance.id,
      targetChannelPublicId,
      createdAt: Date.now()
    })
    .onConflictDoNothing()
    .returning({ id: channelFollows.id });

  if (inserted.length > 0) void publishFollowsUpdate(source.channel.id);

  return signedJsonResponse(
    res,
    200,
    {
      success: true,
      sourceChannelName: source.channel.name,
      sourceServerName: source.server.name
    },
    fromDomain
  );
};

const federationAnnouncementHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const action = signedBody.action;
  const sourceChannelPublicId = signedBody.sourceChannelPublicId;
  const targetChannelPublicId = signedBody.targetChannelPublicId;

  if (action !== 'create' && action !== 'update' && action !== 'delete') {
    return jsonResponse(res, 400, { error: 'Invalid action' });
  }
  if (!isPeerPublicId(sourceChannelPublicId) || !isPeerPublicId(targetChannelPublicId)) {
    return jsonResponse(res, 400, { error: 'Missing channel ids' });
  }

  // Our own row is the authority on what we follow: the peer may only
  // write into a channel that subscribed to that source on that peer.
  const [target] = await db
    .select({ id: channels.id, follow: channelFollows.id })
    .from(channels)
    .innerJoin(
      channelFollows,
      and(
        eq(channelFollows.targetChannelId, channels.id),
        eq(channelFollows.sourceInstanceId, instance.id),
        eq(channelFollows.sourceChannelPublicId, sourceChannelPublicId)
      )
    )
    .where(eq(channels.publicId, targetChannelPublicId))
    .limit(1);

  if (!target) {
    logger.debug('[announcement] %s from %s ignored: not following', action, fromDomain);
    return signedJsonResponse(res, 200, { ignored: 'not_following' }, fromDomain);
  }

  if (action === 'delete') {
    const ids = signedBody.messageIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DELETE_IDS) {
      return jsonResponse(res, 400, { error: 'Invalid messageIds' });
    }
    // The copies become tombstones here as the source did there. The
    // deleter is an account on the peer, so nobody local is named;
    // the time is ours (the relay carries none).
    const tombstone = { deletedAt: Date.now(), deletedBy: null };
    let removed = 0;
    for (const raw of ids) {
      const messageId = peerInteger(raw, { min: 1, max: MAX_MESSAGE_ID });
      if (messageId === undefined) {
        return jsonResponse(res, 400, { error: 'Invalid messageIds' });
      }
      removed += await tombstoneAnnouncementCopies(
        remoteSourceKey(fromDomain, sourceChannelPublicId, messageId),
        tombstone,
        [target.id]
      );
    }
    return signedJsonResponse(res, 200, { success: true, removed }, fromDomain);
  }

  const messageId = peerInteger(signedBody.messageId, { min: 1, max: MAX_MESSAGE_ID });
  const content = signedBody.content;
  const author = signedBody.author as Record<string, unknown> | undefined;
  const authorPublicId = author?.publicId;
  const authorName = peerString(author?.name, MAX_PEER_NAME_LENGTH);

  if (messageId === undefined) {
    return jsonResponse(res, 400, { error: 'Invalid messageId' });
  }
  if (typeof content !== 'string' || content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return jsonResponse(res, 400, { error: 'Invalid content' });
  }
  if (!isPeerPublicId(authorPublicId) || authorName === undefined) {
    return jsonResponse(res, 400, { error: 'Invalid author' });
  }

  const avatarName = peerFileName(author?.avatar);
  const avatarUrl = avatarName
    ? `${getFederationProtocol(fromDomain)}://${fromDomain}/public/${avatarName}`
    : null;

  const shadow = await findOrCreateShadowUserByPublicId(instance.id, authorPublicId, authorName);
  if (avatarUrl) void syncShadowUserAvatar(shadow.id, avatarUrl);

  const sourceKey = remoteSourceKey(fromDomain, sourceChannelPublicId, messageId);
  const edited = signedBody.edited === true;

  if (action === 'update') {
    const updated = await updateAnnouncementCopies(sourceKey, { content, edited }, [target.id]);
    if (updated > 0) {
      return signedJsonResponse(res, 200, { success: true }, fromDomain);
    }
    // No copy yet (the create is still in the peer's outbox, or was
    // never delivered): the update carries everything, so create it.
  }

  const row: TAnnouncementRow = {
    kind: 'announcement',
    sourceKey,
    source: {
      domain: fromDomain,
      serverPublicId: peerString(signedBody.sourceServerPublicId, 64) ?? '',
      serverName: peerString(signedBody.sourceServerName, MAX_PEER_SERVER_NAME_LENGTH) ?? '',
      channelPublicId: sourceChannelPublicId,
      channelName: peerString(signedBody.sourceChannelName, MAX_PEER_SERVER_NAME_LENGTH) ?? ''
    },
    messageId,
    content,
    author: { publicId: authorPublicId, name: authorName, avatarUrl },
    edited
  };

  const copyId = await upsertAnnouncementCopy(target.id, row, shadow.id, Date.now());

  return signedJsonResponse(res, 200, { success: true, messageId: copyId }, fromDomain);
};

export { federationAnnouncementFollowHandler, federationAnnouncementHandler };
