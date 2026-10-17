import { db } from '../db';
import { servers } from '../db/schema';
import { PluginActionError } from './errors';

/**
 * The user account plugin actions are recorded under.
 *
 * Messages, reactions and files all need a `users` row, and the choice
 * is the INSTANCE OWNER — the owner of the bootstrap server, the one
 * person who can enable a plugin in the first place — rather than a
 * shadow user minted per plugin:
 *
 *  - accountability matches the webhook path, where the webhook's
 *    creator is the row's user and the one automod holds responsible;
 *  - storage quotas land on the person who installed the plugin
 *    instead of on an unbounded pool of synthetic accounts;
 *  - shadow users are a federation identity concept (publicId, home
 *    instance, DM reachability) and a per-plugin one would surface in
 *    member lists, DM search and the mod view as a "user" nobody can
 *    talk to.
 *
 * What the reader sees is decided by the per-message persona
 * (`author` on `actions.messages.post`), not by this row — the same
 * split webhooks use.
 */
const getPluginActorUserId = async (): Promise<number> => {
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .orderBy(servers.id)
    .limit(1);

  if (server?.ownerId == null) {
    throw new PluginActionError(
      'UNAVAILABLE',
      'This instance has no owner account yet; plugin actions need one'
    );
  }

  return server.ownerId;
};

export { getPluginActorUserId };
