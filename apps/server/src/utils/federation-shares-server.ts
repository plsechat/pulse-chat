import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { sharesServerWith } from '../db/queries/servers';
import { federationInstances, userFederatedServers, users } from '../db/schema';
import { logger } from '../logger';
import { queryInstance } from './federation';

/**
 * Federation-aware "do these two users share a server?" guard.
 *
 * The plain `sharesServerWith` self-joins the LOCAL serverMembers table,
 * which is blind to federation: when the caller's membership of a peer's
 * server exists only as a userFederatedServers row here and the target
 * is that peer's shadow user (zero serverMembers rows), the check can
 * structurally never pass — the v0.1.5 hardening regression that
 * blocked federated users from friending/DMing a peer server's locals.
 *
 * Remote arm: when the target is a shadow AND the caller belongs to at
 * least one server of the shadow's home instance, ask that instance for
 * a signed co-membership attestation (it hosts the real serverMembers
 * rows for both sides). Fails CLOSED — any network/signature failure
 * denies, matching the guard's anti-spam intent.
 */
const sharesServerWithFederationAware = async (
  callerId: number,
  targetId: number
): Promise<boolean> => {
  if (await sharesServerWith(callerId, targetId)) return true;

  if (!config.federation.enabled) return false;

  const [target] = await db
    .select({
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedPublicId: users.federatedPublicId
    })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);

  if (
    !target?.isFederated ||
    !target.federatedInstanceId ||
    !target.federatedPublicId
  ) {
    return false;
  }

  // Cheap pre-filter: no membership on the shadow's home instance means
  // no shared server is possible — skip the network round-trip.
  const [membership] = await db
    .select({ id: userFederatedServers.id })
    .from(userFederatedServers)
    .where(
      and(
        eq(userFederatedServers.userId, callerId),
        eq(userFederatedServers.instanceId, target.federatedInstanceId)
      )
    )
    .limit(1);

  if (!membership) return false;

  const [caller] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, callerId))
    .limit(1);

  const [instance] = await db
    .select({
      domain: federationInstances.domain,
      status: federationInstances.status
    })
    .from(federationInstances)
    .where(eq(federationInstances.id, target.federatedInstanceId))
    .limit(1);

  if (!caller || !instance || instance.status !== 'active') return false;

  const result = await queryInstance<{ shares?: boolean }>(
    instance.domain,
    '/federation/shares-server',
    {
      fromPublicId: caller.publicId,
      targetPublicId: target.federatedPublicId
    }
  );

  if (result === null) {
    logger.warn(
      '[shares-server] attestation query to %s failed — denying',
      instance.domain
    );
    return false;
  }

  return result.shares === true;
};

export { sharesServerWithFederationAware };
