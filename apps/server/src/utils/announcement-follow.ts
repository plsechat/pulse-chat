/**
 * Announcement follow — the copy side.
 *
 * A message posted in an announcement channel is copied into every
 * channel that follows it as a `type: 'system'` row whose content is a
 * TAnnouncementRow JSON document (content + author persona + where it
 * came from). Edits rewrite the copies, deletions remove them,
 * reactions stay where they were made. Followers on this instance get
 * their row written here; followers on a federated peer get a signed
 * relay through the outbox (`/federation/announcement`, receiver in
 * http/federation-announcement.ts) and write their own.
 *
 * Copies are addressed by `sourceKey` (see TAnnouncementRow): the JSON
 * is written with `kind` and `sourceKey` first, so a prefix LIKE on the
 * content finds every copy of one source message without a column of
 * its own, and a replayed relay lands on the existing row instead of a
 * second one.
 *
 * Every entry point is fire-and-forget safe: it never rejects, so the
 * send/edit/delete routes stay unaffected by a follower that cannot be
 * written or a peer that is down.
 */

import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { and, eq, inArray, like } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { publishMessage } from '../db/publishers';
import { getAffectedUserIdsForChannel } from '../db/queries/channels';
import {
  channelFollows,
  channels,
  federationInstances,
  files,
  messages,
  servers,
  users
} from '../db/schema';
import { logger } from '../logger';
import type { TAnnouncementRow } from '../types';
import { enqueueRelay } from './federation-outbox';
import { pubsub } from './pubsub';

const ANNOUNCEMENT_RELAY_PATH = '/federation/announcement';
const ANNOUNCEMENT_FOLLOW_RELAY_PATH = '/federation/announcement-follow';
/** Ids one deletion relay carries — the bulk-delete route's own cap. */
const MAX_DELETE_IDS_PER_RELAY = 100;

type TAnnouncementSource = {
  domain: string | null;
  serverPublicId: string;
  serverName: string;
  channelPublicId: string;
  channelName: string;
};

const localSourceKey = (channelId: number, messageId: number) =>
  `local:${channelId}:${messageId}`;

const remoteSourceKey = (domain: string, channelPublicId: string, messageId: number) =>
  `${domain}:${channelPublicId}:${messageId}`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The stored JSON starts `{"kind":"announcement","sourceKey":"…",` —
 * JSON.stringify keeps insertion order, and buildAnnouncementRow puts
 * those two keys first.
 */
const copyPrefixPattern = (sourceKey: string) =>
  `${escapeLike(JSON.stringify({ kind: 'announcement', sourceKey }).slice(0, -1))},%`;

const serializeRow = (row: TAnnouncementRow) =>
  JSON.stringify({
    kind: row.kind,
    sourceKey: row.sourceKey,
    source: row.source,
    messageId: row.messageId,
    content: row.content,
    author: row.author,
    edited: row.edited
  });

const findCopies = async (
  sourceKey: string,
  targetChannelIds?: number[]
): Promise<{ id: number; channelId: number; content: string | null }[]> => {
  if (targetChannelIds !== undefined && targetChannelIds.length === 0) return [];

  return db
    .select({ id: messages.id, channelId: messages.channelId, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.type, 'system'),
        like(messages.content, copyPrefixPattern(sourceKey)),
        targetChannelIds === undefined
          ? undefined
          : inArray(messages.channelId, targetChannelIds)
      )
    );
};

/**
 * Write the copy into `targetChannelId` unless one exists; returns the
 * copy's message id either way. `authorUserId` is the local row the
 * author is represented by (the author themself here, their shadow on
 * a peer) — the FK needs a user, the card renders the persona.
 */
const upsertAnnouncementCopy = async (
  targetChannelId: number,
  row: TAnnouncementRow,
  authorUserId: number,
  createdAt: number
): Promise<number> => {
  const [existing] = await findCopies(row.sourceKey, [targetChannelId]);
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(messages)
    .values({
      channelId: targetChannelId,
      userId: authorUserId,
      content: serializeRow(row),
      type: 'system',
      editable: false,
      createdAt
    })
    .returning({ id: messages.id });

  await publishMessage(inserted!.id, targetChannelId, 'create');
  return inserted!.id;
};

/** Rewrite content + edited on every copy of the source message. */
const updateAnnouncementCopies = async (
  sourceKey: string,
  patch: { content: string; edited: boolean },
  targetChannelIds?: number[]
): Promise<number> => {
  const copies = await findCopies(sourceKey, targetChannelIds);

  for (const copy of copies) {
    let parsed: TAnnouncementRow;
    try {
      parsed = JSON.parse(copy.content ?? '') as TAnnouncementRow;
    } catch {
      continue;
    }

    await db
      .update(messages)
      .set({
        content: serializeRow({ ...parsed, content: patch.content, edited: patch.edited }),
        edited: patch.edited,
        updatedAt: Date.now()
      })
      .where(eq(messages.id, copy.id));

    await publishMessage(copy.id, copy.channelId, 'update');
  }

  return copies.length;
};

const deleteAnnouncementCopies = async (
  sourceKey: string,
  targetChannelIds?: number[]
): Promise<number> => {
  const copies = await findCopies(sourceKey, targetChannelIds);
  if (copies.length === 0) return 0;

  await db.delete(messages).where(
    inArray(
      messages.id,
      copies.map((c) => c.id)
    )
  );

  for (const copy of copies) {
    await publishMessage(copy.id, copy.channelId, 'delete');
  }

  return copies.length;
};

type TAuthorPersona = TAnnouncementRow['author'];

/** The author as the copy shows them: publicId, name, `/public/` avatar name. */
const loadAuthorPersona = async (
  userId: number
): Promise<(TAuthorPersona & { avatarName: string | null }) | undefined> => {
  const [row] = await db
    .select({ publicId: users.publicId, name: users.name, avatarName: files.name })
    .from(users)
    .leftJoin(files, eq(users.avatarId, files.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return undefined;

  return {
    publicId: row.publicId,
    name: row.name,
    avatarUrl: row.avatarName ? `/public/${row.avatarName}` : null,
    avatarName: row.avatarName
  };
};

type TSourceMessage = {
  message: typeof messages.$inferSelect;
  channel: typeof channels.$inferSelect;
  server: { publicId: string; name: string };
};

/**
 * A message that announcement-propagates: a plain user row (polls and
 * system rows stay put, so copies never chain) in an announcement
 * channel, plaintext (an encrypted row is ciphertext we cannot show).
 */
const loadSourceMessage = async (messageId: number): Promise<TSourceMessage | undefined> => {
  const [row] = await db
    .select({
      message: messages,
      channel: channels,
      server: { publicId: servers.publicId, name: servers.name }
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .innerJoin(servers, eq(channels.serverId, servers.id))
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!row) return undefined;
  if (!row.channel.announcement || row.message.type !== 'user' || row.message.e2ee) {
    return undefined;
  }
  return row;
};

type TFollowerRow = {
  follow: typeof channelFollows.$inferSelect;
  instance: { domain: string; status: string } | null;
};

const loadFollowers = async (sourceChannelId: number): Promise<TFollowerRow[]> =>
  db
    .select({
      follow: channelFollows,
      instance: { domain: federationInstances.domain, status: federationInstances.status }
    })
    .from(channelFollows)
    .leftJoin(federationInstances, eq(channelFollows.targetInstanceId, federationInstances.id))
    .where(eq(channelFollows.sourceChannelId, sourceChannelId));

const localSource = (src: TSourceMessage): TAnnouncementSource => ({
  domain: null,
  serverPublicId: src.server.publicId,
  serverName: src.server.name,
  channelPublicId: src.channel.publicId,
  channelName: src.channel.name
});

/**
 * Copy (or re-copy after an edit) `messageId` into every follower
 * channel. Local followers get their row here; each active remote
 * follower gets one signed relay, keyed so a replay is idempotent.
 */
const relayAnnouncement = async (
  messageId: number,
  action: 'create' | 'update'
): Promise<void> => {
  try {
    const src = await loadSourceMessage(messageId);
    if (!src) return;

    const followers = await loadFollowers(src.channel.id);
    if (followers.length === 0) return;

    const author = await loadAuthorPersona(src.message.userId);
    if (!author) return;

    const content = src.message.content ?? '';
    const sourceKey = localSourceKey(src.channel.id, src.message.id);
    const row: TAnnouncementRow = {
      kind: 'announcement',
      sourceKey,
      source: localSource(src),
      messageId: src.message.id,
      content,
      author: { publicId: author.publicId, name: author.name, avatarUrl: author.avatarUrl },
      edited: src.message.edited
    };

    const localTargets = followers
      .map((f) => f.follow.targetChannelId)
      .filter((id): id is number => id !== null);

    if (action === 'create') {
      for (const targetChannelId of localTargets) {
        await upsertAnnouncementCopy(targetChannelId, row, src.message.userId, Date.now());
      }
    } else if (localTargets.length > 0) {
      await updateAnnouncementCopies(sourceKey, { content, edited: row.edited }, localTargets);
    }

    if (!config.federation.enabled) return;

    for (const { follow, instance } of followers) {
      if (!instance || instance.status !== 'active' || !follow.targetChannelPublicId) continue;

      void enqueueRelay(instance.domain, ANNOUNCEMENT_RELAY_PATH, {
        action,
        sourceServerPublicId: src.server.publicId,
        sourceServerName: src.server.name,
        sourceChannelPublicId: src.channel.publicId,
        sourceChannelName: src.channel.name,
        targetChannelPublicId: follow.targetChannelPublicId,
        messageId: src.message.id,
        content,
        edited: row.edited,
        author: {
          publicId: author.publicId,
          name: author.name,
          avatar: author.avatarName
        }
      }, {
        relayId: `${action}:${src.channel.publicId}:${src.message.id}:${src.message.updatedAt ?? 0}`
      });
    }
  } catch (err) {
    logger.error('[announcement-follow] relay %s of message %d failed: %o', action, messageId, err);
  }
};

/**
 * Remove the copies of deleted source messages. The source rows are
 * already gone, so the caller passes the channel; a channel that is
 * not an announcement channel has no copies to speak of.
 */
const relayAnnouncementDeletion = async (
  channelId: number,
  messageIds: number[]
): Promise<void> => {
  try {
    if (messageIds.length === 0) return;

    const [channel] = await db
      .select({ id: channels.id, publicId: channels.publicId, announcement: channels.announcement })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!channel?.announcement) return;

    const followers = await loadFollowers(channel.id);
    if (followers.length === 0) return;

    const localTargets = followers
      .map((f) => f.follow.targetChannelId)
      .filter((id): id is number => id !== null);

    if (localTargets.length > 0) {
      for (const messageId of messageIds) {
        await deleteAnnouncementCopies(localSourceKey(channel.id, messageId), localTargets);
      }
    }

    if (!config.federation.enabled) return;

    for (const { follow, instance } of followers) {
      if (!instance || instance.status !== 'active' || !follow.targetChannelPublicId) continue;

      for (let i = 0; i < messageIds.length; i += MAX_DELETE_IDS_PER_RELAY) {
        const slice = messageIds.slice(i, i + MAX_DELETE_IDS_PER_RELAY);
        void enqueueRelay(instance.domain, ANNOUNCEMENT_RELAY_PATH, {
          action: 'delete',
          sourceChannelPublicId: channel.publicId,
          targetChannelPublicId: follow.targetChannelPublicId,
          messageIds: slice
        }, {
          relayId: `delete:${channel.publicId}:${slice[0]}:${slice.length}`
        });
      }
    }
  } catch (err) {
    logger.error(
      '[announcement-follow] deletion relay for channel %d failed: %o',
      channelId,
      err
    );
  }
};

/** CHANNEL_FOLLOWS_UPDATE to everyone who can see the channel. */
const publishFollowsUpdate = async (channelId: number): Promise<void> => {
  try {
    const audience = await getAffectedUserIdsForChannel(channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    pubsub.publishFor(audience, ServerEvents.CHANNEL_FOLLOWS_UPDATE, { channelId });
  } catch (err) {
    logger.error(
      '[announcement-follow] follows publish failed for channel %d: %o',
      channelId,
      err
    );
  }
};

export {
  ANNOUNCEMENT_FOLLOW_RELAY_PATH,
  ANNOUNCEMENT_RELAY_PATH,
  deleteAnnouncementCopies,
  publishFollowsUpdate,
  relayAnnouncement,
  relayAnnouncementDeletion,
  remoteSourceKey,
  updateAnnouncementCopies,
  upsertAnnouncementCopy
};
