/**
 * POST /federation/member-removed — receiver side of federated
 * moderation propagation (see utils/federation-moderation-dispatch.ts).
 *
 * A peer instance kicked or banned one of OUR users from one of ITS
 * servers. Wire body (signed like every relay payload):
 *
 *   {
 *     fromDomain: string            // signed
 *     subjectPublicId: string       // OUR user's publicId
 *     serverPublicId: string        // the peer server they were removed from
 *     serverName?: string
 *     action: 'kick' | 'ban'
 *     reason?: string
 *     signature: string
 *   }
 *
 * Receiver semantics:
 *   - Resolve OUR local user by publicId (never a shadow — the subject
 *     is a user whose home is this instance)
 *   - Delete the userFederatedServers membership row for
 *     (user, fromInstance, serverPublicId) so the server stops
 *     re-appearing in their rail on reload
 *   - Pubsub FEDERATED_SERVER_REMOVED to the user so connected clients
 *     drop the entry live and surface the reason
 *   - Idempotent: repeated delivery is a no-op (row already gone; the
 *     client-side removal is idempotent too)
 */

import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { userFederatedServers, users } from '../db/schema';
import { logger } from '../logger';
import { signedJsonResponse } from '../utils/federation';
import { pubsub } from '../utils/pubsub';
import {
  authorizeFederationRequest,
  jsonResponse
} from './federation-helpers';

const federationMemberRemovedHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const subjectPublicId = signedBody.subjectPublicId as string | undefined;
  const serverPublicId = signedBody.serverPublicId as string | undefined;
  const serverName = signedBody.serverName as string | undefined;
  const action = signedBody.action as string | undefined;
  const reason = signedBody.reason as string | undefined;

  if (!subjectPublicId || typeof subjectPublicId !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing subjectPublicId' });
  }
  if (!serverPublicId || typeof serverPublicId !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing serverPublicId' });
  }
  if (action !== 'kick' && action !== 'ban') {
    return jsonResponse(res, 400, { error: 'Invalid action' });
  }

  // The subject must be one of OUR users (their home is this instance).
  // 200-ignore unknowns — don't leak user existence by status code.
  const [subject] = await db
    .select({ id: users.id, isFederated: users.isFederated })
    .from(users)
    .where(eq(users.publicId, subjectPublicId))
    .limit(1);

  if (!subject || subject.isFederated) {
    logger.warn('[member-removed] no local user for subjectPublicId, ignoring');
    return signedJsonResponse(res, 200, { ignored: 'unknown_subject' }, fromDomain);
  }

  // Drop the membership record for that peer server. The sender is only
  // authoritative for servers on ITS OWN instance — scope the delete to
  // the authenticated instance so a peer can't remove memberships it
  // doesn't host.
  const deleted = await db
    .delete(userFederatedServers)
    .where(
      and(
        eq(userFederatedServers.userId, subject.id),
        eq(userFederatedServers.instanceId, instance.id),
        eq(userFederatedServers.remoteServerPublicId, serverPublicId)
      )
    )
    .returning({ remoteServerName: userFederatedServers.remoteServerName });

  // Notify connected clients either way — the membership row may already
  // be gone (repeat delivery) while a client still shows a stale entry.
  pubsub.publishFor(subject.id, ServerEvents.FEDERATED_SERVER_REMOVED, {
    instanceDomain: fromDomain,
    serverPublicId,
    serverName: deleted[0]?.remoteServerName ?? serverName,
    action,
    // Bound like other peer-supplied text — never trust a peer with
    // unbounded strings.
    ...(reason !== undefined
      ? { reason: String(reason).slice(0, 512) }
      : {})
  });

  logger.debug(
    '[member-removed] userId=%d action=%s rowsDeleted=%d',
    subject.id,
    action,
    deleted.length
  );

  return signedJsonResponse(res, 200, { success: true }, fromDomain);
};

export { federationMemberRemovedHandler };
