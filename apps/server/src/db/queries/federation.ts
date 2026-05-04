import { and, eq } from 'drizzle-orm';
import { db } from '..';
import { federationInstances } from '../schema';

async function getFederationInstanceById(id: number) {
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.id, id))
    .limit(1);

  return instance;
}

async function getFederationInstanceByDomain(domain: string) {
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.domain, domain))
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

async function listFederationInstances() {
  return db.select().from(federationInstances);
}

async function listActiveFederationInstances() {
  return db
    .select({
      id: federationInstances.id,
      domain: federationInstances.domain,
      name: federationInstances.name,
      lastSeenAt: federationInstances.lastSeenAt
    })
    .from(federationInstances)
    .where(eq(federationInstances.status, 'active'));
}

export {
  getActiveFederationInstanceByDomain,
  getFederationInstanceByDomain,
  getFederationInstanceById,
  listActiveFederationInstances,
  listFederationInstances
};
