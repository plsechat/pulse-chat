/**
 * Federation propagation for moderation actions (kick / ban).
 *
 * When an admin here kicks or bans a FEDERATED member (a shadow user
 * whose real account lives on a peer instance), the local action alone
 * leaves the peer side stale: the user's home instance still holds a
 * userFederatedServers membership row, so our server keeps re-appearing
 * in their client rail, and the user gets no signal about what happened.
 *
 * This dispatcher notifies the target's HOME instance via the signed
 * relay channel. The peer deletes its membership record and pushes a
 * FEDERATED_SERVER_REMOVED event to the user's connected clients (see
 * http/federation-member-removed.ts for the receiver).
 *
 * Fire-and-forget: local moderation must never fail because a peer is
 * unreachable. Errors are logged and the relay is not retried — if the
 * peer missed it, the stale rail entry is cosmetic and the user is
 * still locked out here (kick removed membership; ban blocks the WS).
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { federationInstances, servers, users } from '../db/schema';
import { logger } from '../logger';
import { config } from '../config';
import { relayToInstance } from './federation';

async function relayFederatedModeration(
  targetUserId: number,
  serverId: number,
  action: 'kick' | 'ban',
  reason?: string
): Promise<void> {
  try {
    if (!config.federation.enabled) return;

    const [target] = await db
      .select({
        isFederated: users.isFederated,
        federatedInstanceId: users.federatedInstanceId,
        federatedPublicId: users.federatedPublicId
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!target?.isFederated) return;
    if (!target.federatedInstanceId || !target.federatedPublicId) {
      // Legacy shadow row without a home publicId — nothing to address
      // the relay to. The local action still stands.
      logger.debug(
        '[relayFederatedModeration] skipped userId=%d (no federatedPublicId)',
        targetUserId
      );
      return;
    }

    const [instance] = await db
      .select({
        domain: federationInstances.domain,
        status: federationInstances.status
      })
      .from(federationInstances)
      .where(eq(federationInstances.id, target.federatedInstanceId))
      .limit(1);

    if (!instance || instance.status !== 'active') return;

    const [server] = await db
      .select({ publicId: servers.publicId, name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!server) return;

    await relayToInstance(instance.domain, '/federation/member-removed', {
      subjectPublicId: target.federatedPublicId,
      serverPublicId: server.publicId,
      serverName: server.name,
      action,
      ...(reason !== undefined ? { reason } : {})
    });
  } catch (err) {
    logger.error(
      '[relayFederatedModeration] failed for userId=%d action=%s: %o',
      targetUserId,
      action,
      err
    );
  }
}

export { relayFederatedModeration };
