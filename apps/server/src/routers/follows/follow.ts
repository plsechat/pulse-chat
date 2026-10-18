import { ChannelPermission, ChannelType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { channelFollows, channels, federationInstances, servers } from '../../db/schema';
import {
  ANNOUNCEMENT_FOLLOW_RELAY_PATH,
  publishFollowsUpdate
} from '../../utils/announcement-follow';
import { queryInstance } from '../../utils/federation';
import { enqueueRelay } from '../../utils/federation-outbox';
import { invariant } from '../../utils/invariant';
import { userHasChannelPermission } from '../../utils/member-permissions';
import { serverProcedure } from '../../utils/procedures';
import { MAX_FOLLOW_ADDRESS_LENGTH, parseRemoteFollowAddress } from './_shared';

/** Postgres unique_violation, wrapped by drizzle one or more levels deep. */
const isUniqueViolation = (err: unknown): boolean => {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * Make `channelId` (a text channel of the active server) follow an
 * announcement channel: one on this instance the caller can view, or
 * one on a federated peer given by address. MANAGE_CHANNELS on the
 * target's server is the whole authority; the source side only has to
 * be visible to the caller (local) or followable by policy (remote:
 * the peer checks that its server is federatable and the channel a
 * public announcement channel).
 */
const followRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(
    z.object({
      channelId: z.number().int().positive(),
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('local'), channelId: z.number().int().positive() }),
        z.object({
          kind: z.literal('remote'),
          address: z.string().min(1).max(MAX_FOLLOW_ADDRESS_LENGTH)
        })
      ])
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [target] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(target, { code: 'NOT_FOUND', message: 'Channel not found' });
    invariant(target.type === ChannelType.TEXT, {
      code: 'BAD_REQUEST',
      message: 'Only text channels can follow an announcement channel'
    });

    const now = Date.now();

    if (input.source.kind === 'local') {
      const [source] = await db
        .select({
          id: channels.id,
          serverId: channels.serverId,
          type: channels.type,
          announcement: channels.announcement
        })
        .from(channels)
        .where(eq(channels.id, input.source.channelId))
        .limit(1);

      // Visibility is checked before anything about the channel is
      // revealed: a channel the caller cannot see is "not found".
      const visible =
        source !== undefined &&
        (await userHasChannelPermission(
          ctx.userId,
          source.serverId,
          source.id,
          ChannelPermission.VIEW_CHANNEL
        ));
      invariant(source && visible, { code: 'NOT_FOUND', message: 'Source channel not found' });
      invariant(source.announcement && source.type === ChannelType.TEXT, {
        code: 'BAD_REQUEST',
        message: 'Only announcement channels can be followed'
      });
      invariant(source.id !== target.id, {
        code: 'BAD_REQUEST',
        message: 'A channel cannot follow itself'
      });

      try {
        await db.insert(channelFollows).values({
          sourceChannelId: source.id,
          targetChannelId: target.id,
          createdBy: ctx.userId,
          createdAt: now
        });
      } catch (err) {
        invariant(!isUniqueViolation(err), {
          code: 'CONFLICT',
          message: 'This channel already follows that one'
        });
        throw err;
      }

      void publishFollowsUpdate(target.id);
      void publishFollowsUpdate(source.id);
      return { status: 'following' as const };
    }

    invariant(config.federation.enabled, {
      code: 'BAD_REQUEST',
      message: 'Federation is not enabled on this instance'
    });

    const address = parseRemoteFollowAddress(input.source.address);
    invariant(address, {
      code: 'BAD_REQUEST',
      message: 'Use the form domain/server-id/channel-id'
    });
    invariant(address.domain !== config.federation.domain.toLowerCase(), {
      code: 'BAD_REQUEST',
      message: 'Pick the channel from the list to follow one on this instance'
    });

    const [instance] = await db
      .select({ id: federationInstances.id, domain: federationInstances.domain })
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.domain, address.domain),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);
    invariant(instance, {
      code: 'NOT_FOUND',
      message: 'That instance is not a federation peer of this one'
    });

    const [server] = await db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, ctx.activeServerId))
      .limit(1);

    let followId: number;
    try {
      const [row] = await db
        .insert(channelFollows)
        .values({
          sourceInstanceId: instance.id,
          sourceChannelPublicId: address.channelPublicId,
          targetChannelId: target.id,
          createdBy: ctx.userId,
          createdAt: now
        })
        .returning({ id: channelFollows.id });
      followId = row!.id;
    } catch (err) {
      invariant(!isUniqueViolation(err), {
        code: 'CONFLICT',
        message: 'This channel already follows that one'
      });
      throw err;
    }

    const payload = {
      action: 'follow' as const,
      serverPublicId: address.serverPublicId,
      channelPublicId: address.channelPublicId,
      targetChannelPublicId: target.publicId,
      targetChannelName: target.name,
      targetServerName: server?.name ?? ''
    };

    // Ask the peer now, so a channel that is not followable is refused
    // in the same click; a peer that is down gets the request from
    // the outbox and the follow shows as pending until then.
    const answer = await queryInstance<{ success?: boolean; ignored?: string }>(
      instance.domain,
      ANNOUNCEMENT_FOLLOW_RELAY_PATH,
      payload
    );

    if (answer && answer.success !== true) {
      await db.delete(channelFollows).where(eq(channelFollows.id, followId));
      invariant(false, {
        code: 'BAD_REQUEST',
        message: 'That channel cannot be followed: it is not a public announcement channel of a federatable server'
      });
    }

    if (!answer) {
      void enqueueRelay(instance.domain, ANNOUNCEMENT_FOLLOW_RELAY_PATH, payload, {
        relayId: `follow:${address.channelPublicId}:${target.publicId}`
      });
    }

    void publishFollowsUpdate(target.id);
    return { status: answer ? ('following' as const) : ('pending' as const) };
  });

export { followRoute };
