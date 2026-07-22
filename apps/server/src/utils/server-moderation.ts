import { ActivityLogType, DisconnectCode, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import {
  getServerById,
  isServerMember,
  removeServerMember
} from '../db/queries/servers';
import { users } from '../db/schema';
import { enqueueActivityLog } from '../queues/activity-log';
import { markBanned } from './banned-cache';
import { relayFederatedModeration } from './federation-moderation-dispatch';
import type { Context } from './trpc';

/**
 * Server-moderation cores shared by the users.kick/users.ban routes and
 * report resolution. Callers are responsible for authorization; both
 * no-op (returning false) when the target isn't a member, so resolvers
 * can call them on a target who already left.
 */

const kickFromServer = async (opts: {
  targetUserId: number;
  serverId: number;
  reason: string | undefined;
  kickedBy: number;
  getUserWs: Context['getUserWs'];
  pubsub: Context['pubsub'];
}): Promise<boolean> => {
  const isMember = await isServerMember(opts.serverId, opts.targetUserId);
  if (!isMember) return false;

  const userConnections = opts.getUserWs(opts.targetUserId);
  if (userConnections) {
    for (const ws of userConnections) {
      ws.close(DisconnectCode.KICKED, opts.reason);
    }
  }

  await removeServerMember(opts.serverId, opts.targetUserId);

  // Include the globally-unique publicId so clients can scope the event —
  // the numeric serverId collides across federated instances.
  const server = await getServerById(opts.serverId);

  opts.pubsub.publishFor(opts.targetUserId, ServerEvents.USER_KICKED, {
    serverId: opts.serverId,
    serverPublicId: server?.publicId,
    reason: opts.reason
  });
  opts.pubsub.publishFor(opts.targetUserId, ServerEvents.SERVER_MEMBER_LEAVE, {
    serverId: opts.serverId,
    serverPublicId: server?.publicId,
    userId: opts.targetUserId
  });

  // Fires AFTER removeServerMember, so publishUser reaches the remaining
  // members — the kicked user already received USER_KICKED above.
  publishUser(opts.targetUserId, 'delete', { scopeServerId: opts.serverId });

  // Federated member? Tell their home instance (fire-and-forget —
  // never blocks or fails local moderation).
  relayFederatedModeration(
    opts.targetUserId,
    opts.serverId,
    'kick',
    opts.reason
  );

  enqueueActivityLog({
    type: ActivityLogType.USER_KICKED,
    userId: opts.targetUserId,
    serverId: opts.serverId,
    details: {
      reason: opts.reason,
      kickedBy: opts.kickedBy
    }
  });
  return true;
};

const banServerMember = async (opts: {
  targetUserId: number;
  serverId: number;
  reason: string | undefined;
  bannedBy: number;
  getUserWs: Context['getUserWs'];
}): Promise<boolean> => {
  const isMember = await isServerMember(opts.serverId, opts.targetUserId);
  if (!isMember) return false;

  const userConnections = opts.getUserWs(opts.targetUserId);
  if (userConnections) {
    for (const ws of userConnections) {
      ws.close(DisconnectCode.BANNED, opts.reason);
    }
  }

  await db
    .update(users)
    .set({
      banned: true,
      banReason: opts.reason ?? null,
      bannedAt: Date.now()
    })
    .where(eq(users.id, opts.targetUserId));

  // Reflect the new banned-state in the in-memory cache the auth
  // middleware reads from. Any subsequent protected procedure call
  // by this user (across any of their tabs / WS connections) is
  // rejected without a DB round-trip.
  markBanned(opts.targetUserId);

  // Two events: a global 'update' so co-members across every shared server
  // see the banned flag flip (e.g. for "this user is banned" indicators),
  // and a server-scoped 'delete' so the active server's user list drops
  // them — same UX as kick.
  publishUser(opts.targetUserId, 'update');
  publishUser(opts.targetUserId, 'delete', { scopeServerId: opts.serverId });

  // Federated member? Tell their home instance (fire-and-forget).
  relayFederatedModeration(
    opts.targetUserId,
    opts.serverId,
    'ban',
    opts.reason
  );

  enqueueActivityLog({
    type: ActivityLogType.USER_BANNED,
    userId: opts.targetUserId,
    serverId: opts.serverId,
    details: {
      reason: opts.reason,
      bannedBy: opts.bannedBy
    }
  });
  return true;
};

export { banServerMember, kickFromServer };
