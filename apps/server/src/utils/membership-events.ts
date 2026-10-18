import { ServerEvents } from '@pulse/shared';
import type { TServerSummary } from '../types';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { getServerMemberIds } from '../db/queries/servers';
import { getPublicUserById } from '../db/queries/users';
import { users } from '../db/schema';
import { eventBus } from '../plugins/event-bus';
import type { Context } from './trpc';

/**
 * Membership fan-out shared by every path that makes or unmakes a server
 * member: servers.joinByInvite / joinDiscover / joinFederated on the way
 * in, servers.leave and the kick/ban cores on the way out. Connection
 * events (a member's client session opening a server) are the
 * USER_CONNECTED / `user:connected` family in others/open-session.
 */

/**
 * SERVER_MEMBER_JOIN to every member of the server (the joiner included)
 * and the plugin `member:joined` event. The joiner's clients add
 * `summary` to their rail; the other members add `user` to their roster.
 */
const announceMemberJoin = async (opts: {
  pubsub: Context['pubsub'];
  server: { id: number; publicId: string };
  userId: number;
  username: string;
  summary: TServerSummary;
}) => {
  const [memberIds, publicUser] = await Promise.all([
    getServerMemberIds(opts.server.id),
    getPublicUserById(opts.userId)
  ]);

  opts.pubsub.publishFor(memberIds, ServerEvents.SERVER_MEMBER_JOIN, {
    serverId: opts.server.id,
    serverPublicId: opts.server.publicId,
    userId: opts.userId,
    server: opts.summary,
    user: publicUser ?? undefined
  });

  eventBus.emit('member:joined', {
    userId: opts.userId,
    username: opts.username,
    serverId: opts.server.id
  });
};

/**
 * The plugin `member:left` event for a leave, kick or ban. The pubsub
 * side (SERVER_MEMBER_LEAVE to the leaver, the scoped USER_DELETE to the
 * rest) differs per path and stays with the caller. `username` is looked
 * up when the caller only holds the id (moderation cores).
 */
const announceMemberLeft = async (opts: {
  userId: number;
  username?: string;
  serverId: number;
}) => {
  let username = opts.username;
  if (username === undefined) {
    const [target] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, opts.userId))
      .limit(1);
    username = target?.name ?? '';
  }

  const payload = { userId: opts.userId, username, serverId: opts.serverId };
  eventBus.emit('member:left', payload);
  // Deprecated alias of member:left, emitted for one release so plugins
  // written against the old name keep working. v0.4.0 ships both; delete
  // this emit in v0.5.0.
  eventBus.emit('user:left', payload);
};

export { announceMemberJoin, announceMemberLeft };
