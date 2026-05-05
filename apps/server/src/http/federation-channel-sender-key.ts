/**
 * Phase E / E1c — federation route for cross-instance channel SKDM
 * availability notifications.
 *
 * Model is host-only storage (Decision 1, Option A): the SKDM
 * ciphertext lives on the host instance's e2ee_sender_keys table
 * keyed to the recipient's shadow user id on the host. This handler
 * receives just a notification telling each local recipient that a
 * fresh SKDM is waiting for them on the host — they then call the
 * existing `e2ee.getPendingSenderKeys` route on the host to fetch
 * and decrypt.
 *
 * Wire body (signed):
 *   {
 *     fromDomain: string                    // signed
 *     toDomain: string                      // audience
 *     hostDomain: string                    // channel's host instance
 *     hostChannelPublicId: string           // channel publicId on host
 *     fromPublicId: string                  // sender's publicId
 *     senderKeyId: number
 *     recipientPublicIds: string[]          // local users to notify
 *   }
 */

import { ServerEvents } from '@pulse/shared';
import { inArray } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { users } from '../db/schema';
import { logger } from '../logger';
import { pubsub } from '../utils/pubsub';
import { signedJsonResponse } from '../utils/federation';
import {
  authorizeFederationRequest,
  jsonResponse
} from './federation-helpers';

const federationChannelSenderKeyNotifyHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { signedBody, fromDomain } = auth;

  const hostDomain = signedBody.hostDomain as string | undefined;
  const hostChannelPublicId = signedBody.hostChannelPublicId as string | undefined;
  const fromPublicId = signedBody.fromPublicId as string | undefined;
  const fromInstanceDomain = signedBody.fromInstanceDomain as string | undefined;
  const senderKeyId = signedBody.senderKeyId as number | undefined;
  const recipientPublicIds = signedBody.recipientPublicIds as
    | string[]
    | undefined;

  if (
    !hostDomain ||
    !hostChannelPublicId ||
    !fromPublicId ||
    !fromInstanceDomain ||
    typeof senderKeyId !== 'number' ||
    !Array.isArray(recipientPublicIds)
  ) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Empty list is a valid no-op — handler is idempotent.
  if (recipientPublicIds.length === 0) {
    return signedJsonResponse(res, 200, { notified: 0 }, fromDomain);
  }

  // Resolve each recipient publicId to a local user. Only LOCAL
  // (non-federated) users are valid recipients — a notification
  // about a SKDM on host X should only reach users whose home is
  // this instance.
  const recipients = await db
    .select({ id: users.id, isFederated: users.isFederated })
    .from(users)
    .where(inArray(users.publicId, recipientPublicIds));

  const localRecipientIds = recipients
    .filter((r) => !r.isFederated)
    .map((r) => r.id);

  if (localRecipientIds.length === 0) {
    logger.warn(
      '[channel-sender-key-notify] no local recipients matched — ignoring'
    );
    return signedJsonResponse(res, 200, { notified: 0 }, fromDomain);
  }

  // Pubsub locally — clients receiving this event open or reuse a
  // tRPC to `hostDomain` and call e2ee.getPendingSenderKeys to
  // pull the actual SKDM. The notification carries enough
  // context to scope the fetch.
  for (const userId of localRecipientIds) {
    pubsub.publishFor(
      userId,
      ServerEvents.E2EE_FEDERATED_SENDER_KEY_AVAILABLE,
      {
        hostDomain,
        hostChannelPublicId,
        fromPublicId,
        fromInstanceDomain,
        senderKeyId
      }
    );
  }

  return signedJsonResponse(
    res,
    200,
    { notified: localRecipientIds.length },
    fromDomain
  );
};

export { federationChannelSenderKeyNotifyHandler };
