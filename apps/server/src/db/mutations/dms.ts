import { sql } from 'drizzle-orm';
import { db } from '..';
import { findDmChannelBetween, pairKeyFor } from '../queries/dms';
import { dmChannelMembers, dmChannels } from '../schema';

/**
 * The one way to mint a 1:1 DM. The channel row is upserted on its pair
 * key, so two callers racing on the same pair — a local click and an
 * inbound relay, or two first messages crossing between instances — land
 * on one row; the member rows are then inserted ON CONFLICT DO NOTHING,
 * so a second caller completes a first caller's half-finished creation
 * instead of failing on it. A channel that predates the pair key is
 * adopted (and stamped) via findDmChannelBetween before anything is
 * inserted. `e2ee` applies only to a row minted here.
 */
async function getOrCreatePairChannel(
  userIdA: number,
  userIdB: number,
  opts?: { e2ee?: boolean }
): Promise<{ id: number; created: boolean }> {
  const pairKey = await pairKeyFor(userIdA, userIdB);
  const now = Date.now();

  const existing = await findDmChannelBetween(userIdA, userIdB, pairKey);
  let id = existing;
  let created = false;

  if (id === null) {
    // DO UPDATE (to the same key) rather than DO NOTHING so the statement
    // returns the row either way; xmax = 0 tells an inserted row from a
    // touched one.
    const [row] = await db
      .insert(dmChannels)
      .values({ pairKey, isGroup: false, e2ee: opts?.e2ee ?? false, createdAt: now })
      .onConflictDoUpdate({
        target: dmChannels.pairKey,
        set: { pairKey: sql`excluded."pair_key"` }
      })
      .returning({ id: dmChannels.id, inserted: sql<boolean>`(xmax = 0)` });
    id = row!.id;
    created = row!.inserted;
  }

  // Lowest user id first, whichever side is calling: two callers inserting
  // the same pair in opposite orders each hold one index entry and wait
  // for the other's (deadlock 40P01). With one order the second caller
  // simply queues behind the first on the shared key.
  const [first, second] = userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
  await db
    .insert(dmChannelMembers)
    .values([
      { dmChannelId: id, userId: first, createdAt: now },
      { dmChannelId: id, userId: second, createdAt: now }
    ])
    .onConflictDoNothing();

  return { id, created };
}

export { getOrCreatePairChannel };
