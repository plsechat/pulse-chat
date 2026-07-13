/**
 * POST /federation/shares-server — signed co-membership attestation.
 *
 * A federated user F (homed on the CALLING instance) initiates a friend
 * request or DM with one of OUR local users L. The caller's instance
 * cannot answer "do F and L share a server?" itself: on the home side
 * F's membership of our servers exists only as userFederatedServers
 * rows and L is a shadow with no serverMembers at all — the local
 * `sharesServerWith` guard there can structurally never pass. WE can
 * answer truthfully: F is a shadow with real serverMembers rows here.
 *
 * Body: { fromPublicId  — F's home publicId (matches our shadow row's
 *                         federatedPublicId, scoped to the caller),
 *         targetPublicId — L's publicId on this instance }
 * Response (signed): { shares: boolean }. Unknown users answer
 * `shares: false` with 200 — existence is not leaked by status code.
 */
import { and, eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { sharesServerWith } from '../db/queries/servers';
import { users } from '../db/schema';
import { logger } from '../logger';
import { signedJsonResponse } from '../utils/federation';
import { authorizeFederationRequest, jsonResponse } from './federation-helpers';

const federationSharesServerHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const fromPublicId = signedBody.fromPublicId as string | undefined;
  const targetPublicId = signedBody.targetPublicId as string | undefined;

  if (!fromPublicId || typeof fromPublicId !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing fromPublicId' });
  }
  if (!targetPublicId || typeof targetPublicId !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing targetPublicId' });
  }

  // The subject must be a shadow user homed on the AUTHENTICATED
  // instance — a peer can only ask on behalf of its own users.
  const [shadow] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isFederated, true),
        eq(users.federatedInstanceId, instance.id),
        eq(users.federatedPublicId, fromPublicId)
      )
    )
    .limit(1);

  // The target must be one of OUR local (non-shadow) users.
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.publicId, targetPublicId), eq(users.isFederated, false)))
    .limit(1);

  if (!shadow || !target) {
    return signedJsonResponse(res, 200, { shares: false }, fromDomain);
  }

  const shares = await sharesServerWith(shadow.id, target.id);

  logger.debug(
    '[shares-server] instance=%d shadow=%d target=%d shares=%s',
    instance.id,
    shadow.id,
    target.id,
    shares
  );

  return signedJsonResponse(res, 200, { shares }, fromDomain);
};

export { federationSharesServerHandler };
