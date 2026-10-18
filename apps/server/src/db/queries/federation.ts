import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '..';
import { federationInstances, federationOutbox } from '../schema';

async function getFederationInstanceById(id: number) {
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.id, id))
    .limit(1);

  return instance;
}

async function getActiveFederationInstanceByDomain(domain: string) {
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, domain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  return instance;
}

type OutboxCounts = { pendingOutbox: number; deadOutbox: number };

/**
 * Queued (still retrying) and dead-lettered outbox rows per peer, for
 * the instance lists. Two grouped counts instead of one per instance.
 */
async function getOutboxCountsByInstance(): Promise<Map<number, OutboxCounts>> {
  const pending = await db
    .select({ instanceId: federationOutbox.instanceId, value: count() })
    .from(federationOutbox)
    .where(isNull(federationOutbox.deadAt))
    .groupBy(federationOutbox.instanceId);
  const dead = await db
    .select({ instanceId: federationOutbox.instanceId, value: count() })
    .from(federationOutbox)
    .where(isNotNull(federationOutbox.deadAt))
    .groupBy(federationOutbox.instanceId);

  const counts = new Map<number, OutboxCounts>();
  const entry = (instanceId: number) => {
    let c = counts.get(instanceId);
    if (!c) {
      c = { pendingOutbox: 0, deadOutbox: 0 };
      counts.set(instanceId, c);
    }
    return c;
  };
  for (const row of pending) entry(row.instanceId).pendingOutbox = row.value;
  for (const row of dead) entry(row.instanceId).deadOutbox = row.value;
  return counts;
}

const NO_OUTBOX: OutboxCounts = { pendingOutbox: 0, deadOutbox: 0 };

async function listFederationInstances() {
  const [instances, counts] = await Promise.all([
    db.select().from(federationInstances),
    getOutboxCountsByInstance()
  ]);
  return instances.map((i) => ({ ...i, ...(counts.get(i.id) ?? NO_OUTBOX) }));
}

async function listActiveFederationInstances() {
  const [instances, counts] = await Promise.all([
    db
      .select({
        id: federationInstances.id,
        domain: federationInstances.domain,
        name: federationInstances.name,
        lastSeenAt: federationInstances.lastSeenAt,
        peerVersion: federationInstances.peerVersion,
        lastError: federationInstances.lastError,
        lastErrorAt: federationInstances.lastErrorAt
      })
      .from(federationInstances)
      .where(eq(federationInstances.status, 'active')),
    getOutboxCountsByInstance()
  ]);
  return instances.map((i) => ({ ...i, ...(counts.get(i.id) ?? NO_OUTBOX) }));
}

/** Dead-lettered rows for one peer, newest first. No payload: it may
 *  carry message content, and the panel only needs path + reason. */
async function listDeadOutboxRows(instanceId: number, limit = 100) {
  return db
    .select({
      id: federationOutbox.id,
      path: federationOutbox.path,
      attempts: federationOutbox.attempts,
      lastError: federationOutbox.lastError,
      createdAt: federationOutbox.createdAt,
      deadAt: federationOutbox.deadAt
    })
    .from(federationOutbox)
    .where(
      and(
        eq(federationOutbox.instanceId, instanceId),
        isNotNull(federationOutbox.deadAt)
      )
    )
    .orderBy(desc(federationOutbox.deadAt), desc(federationOutbox.id))
    .limit(limit);
}

export {
  getActiveFederationInstanceByDomain,
  getFederationInstanceById,
  listActiveFederationInstances,
  listDeadOutboxRows,
  listFederationInstances
};
