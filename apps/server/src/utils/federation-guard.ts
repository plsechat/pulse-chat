/**
 * Federation guards (Phase 4 / F9).
 *
 * Federated users in our DB are *shadow* records — projections of a
 * user that actually lives on another instance. Mutating their
 * membership/state locally without propagating the action across
 * federation lets the local server drift from the federated peer
 * (the user is "banned here" but still active there with no signal
 * to either side that we did anything).
 *
 * Until we ship federation propagation for ban/kick/add-role/
 * remove-role, refuse these actions against federated targets at the
 * route boundary. The local admin's recourse is to manage the user
 * on their home instance, or to block the federated INSTANCE
 * entirely via federation/block-instance.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { invariant } from './invariant';

export async function assertNotFederatedTarget(
  targetUserId: number,
  action: string
): Promise<void> {
  const [target] = await db
    .select({ isFederated: users.isFederated })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  invariant(!target?.isFederated, {
    code: 'FORBIDDEN',
    message: `${action} is not supported on federated users — manage them on their home instance`
  });
}
