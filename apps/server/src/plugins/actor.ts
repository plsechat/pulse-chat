import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import { addServerMember, isServerMember } from '../db/queries/servers';
import { externalIdentities, users } from '../db/schema';
import { logger } from '../logger';
import { isPluginActorAuthId, PLUGIN_ACTOR_AUTH_PREFIX } from './actor-id';
import { PluginActionError } from './errors';

/**
 * The user account a plugin's actions are recorded under: one system
 * account PER PLUGIN, minted on first use, that can never sign in.
 *
 * It used to be the instance owner. That made every bridged post the
 * owner's own message, so the one person running the bridge never got
 * a sound, a desktop notification or an unread marker for it — and a
 * moderator reading the audit trail saw the owner "posting" a
 * stranger's words. A dedicated account fixes both: the owner is a
 * reader like everyone else, and what the row's user_id says is "the
 * plugin", not a person.
 *
 * The mechanism is the placeholder one (import/placeholders.ts): a
 * users row whose auth-side id carries a prefix no backend issues, plus
 * an external_identities row under provider `plugin:<id>` that finds it
 * again — no schema change. The account joins a server the first time
 * the plugin acts there: the client only renders a message whose author
 * is in the roster, so membership is what makes the post visible, and
 * what puts the plugin in the member list under its own name.
 *
 * Storage quotas land on this account; its name follows the plugin's
 * manifest name. What readers see on a message is still the per-post
 * persona (`author` on `actions.messages.post`), the same split webhooks
 * use.
 */

const PLUGIN_ACTOR_PROVIDER_PREFIX = 'plugin:';
/** users.name cap. */
const MAX_ACTOR_NAME = 32;

type TPluginActorRef = {
  pluginId: string;
  /** The plugin's manifest name; the account is named after it. Defaults to the id. */
  name?: string;
  /** When set, the account is made a member of this server if it is not one yet. */
  serverId?: number;
};

const actorName = (ref: TPluginActorRef): string =>
  Array.from((ref.name ?? ref.pluginId).replace(/[\r\n\t]+/g, ' ').trim())
    .slice(0, MAX_ACTOR_NAME)
    .join('')
    .trim() || ref.pluginId.slice(0, MAX_ACTOR_NAME);

const providerFor = (pluginId: string) => `${PLUGIN_ACTOR_PROVIDER_PREFIX}${pluginId}`;

const findActor = async (pluginId: string) => {
  const [row] = await db
    .select({ userId: externalIdentities.userId, name: users.name })
    .from(externalIdentities)
    .innerJoin(users, eq(users.id, externalIdentities.userId))
    .where(
      and(
        eq(externalIdentities.provider, providerFor(pluginId)),
        eq(externalIdentities.externalId, pluginId)
      )
    )
    .limit(1);

  return row;
};

const mintActor = async (pluginId: string, name: string): Promise<number | undefined> => {
  const now = Date.now();

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        supabaseId: `${PLUGIN_ACTOR_AUTH_PREFIX}${pluginId}`,
        name,
        publicId: randomUUIDv7(),
        createdAt: now,
        lastLoginAt: now
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!user) return undefined;

    const [identity] = await tx
      .insert(externalIdentities)
      .values({
        provider: providerFor(pluginId),
        externalId: pluginId,
        userId: user.id,
        displayName: name,
        avatarUrl: null,
        placeholder: false,
        createdAt: now
      })
      .onConflictDoNothing()
      .returning({ id: externalIdentities.id });
    if (!identity) {
      // A concurrent caller won the identity index; drop our user row.
      await tx.delete(users).where(eq(users.id, user.id));
      return undefined;
    }

    return user.id;
  });
};

const getPluginActorUserId = async (ref: TPluginActorRef): Promise<number> => {
  const name = actorName(ref);
  let actor = await findActor(ref.pluginId);

  if (!actor) {
    const minted = await mintActor(ref.pluginId, name);
    actor = minted !== undefined ? { userId: minted, name } : await findActor(ref.pluginId);

    if (!actor) {
      throw new PluginActionError(
        'UNAVAILABLE',
        `The account for plugin ${ref.pluginId} could not be created`
      );
    }

    if (minted !== undefined) {
      logger.info('[plugins] minted actor account %d for %s', actor.userId, ref.pluginId);
    }
  } else if (ref.name !== undefined && actor.name !== name) {
    // The manifest was renamed: the account follows it.
    await db.update(users).set({ name, updatedAt: Date.now() }).where(eq(users.id, actor.userId));
  }

  if (ref.serverId !== undefined && !(await isServerMember(ref.serverId, actor.userId))) {
    await addServerMember(ref.serverId, actor.userId);
    void publishUser(actor.userId, 'create', { scopeServerId: ref.serverId });
  }

  return actor.userId;
};


export type { TPluginActorRef };
export { getPluginActorUserId, isPluginActorAuthId };
